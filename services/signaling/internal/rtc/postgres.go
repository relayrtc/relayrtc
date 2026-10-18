package rtc

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

type PostgresStore struct {
	pool            *pgxpool.Pool
	signalingNodeID string
}

func NewPostgresStore(pool *pgxpool.Pool, signalingNodeID string) *PostgresStore {
	return &PostgresStore{pool: pool, signalingNodeID: signalingNodeID}
}

func (store *PostgresStore) ReconciliationRooms(ctx context.Context, nodeID string) ([]string, error) {
	rows, err := store.pool.Query(ctx, `SELECT m.room_id FROM rtc_runtime m JOIN room r ON r.id = m.room_id
 WHERE m.state->>'MediaNodeID' = $1 AND (
 ((r.status NOT IN ('created', 'active') OR coalesce((m.state->>'Closing')::boolean, false)) AND coalesce(m.state->>'Generation', '') <> '')
 OR coalesce((m.state->>'Allocating')::boolean, false)
 OR EXISTS (SELECT 1 FROM jsonb_object_keys(m.state->'Sessions') k(id)
 LEFT JOIN participant_session ps ON ps.id = k.id LEFT JOIN participant p ON p.id = ps.participant_id
 WHERE ps.id IS NULL OR ps.connection_state = 'disconnected' OR p.left_at IS NOT NULL)
 OR EXISTS (SELECT 1 FROM jsonb_each(m.state->'Sessions') s WHERE s.value->'Tracks' <> '{}'::jsonb)
 OR EXISTS (SELECT 1 FROM jsonb_each(m.state->'Sessions') s WHERE (s.value->>'Pending')::boolean
 OR EXISTS (SELECT 1 FROM jsonb_each(s.value->'Subscriptions') c
 WHERE NOT coalesce((c.value->>'Resumed')::boolean, false)
 AND coalesce((c.value->>'CreatedAt')::timestamptz, '-infinity'::timestamptz) < now() - interval '1 minute')))
 ORDER BY m.updated_at LIMIT 50`, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roomIDs []string
	for rows.Next() {
		var roomID string
		if err := rows.Scan(&roomID); err != nil {
			return nil, err
		}
		roomIDs = append(roomIDs, roomID)
	}
	return roomIDs, rows.Err()
}

func (room *postgresRoom) Ended(ctx context.Context) (bool, error) {
	var ended bool
	err := room.connection.QueryRow(ctx, `SELECT status NOT IN ('created', 'active') OR ended_at IS NOT NULL FROM room WHERE id = $1`, room.roomID).Scan(&ended)
	return ended, err
}

func (room *postgresRoom) InactiveSessions(ctx context.Context) ([]string, error) {
	rows, err := room.connection.Query(ctx, `SELECT k.id FROM rtc_runtime m,
 LATERAL jsonb_object_keys(m.state->'Sessions') k(id)
 LEFT JOIN participant_session s ON s.id = k.id LEFT JOIN participant p ON p.id = s.participant_id
 WHERE m.room_id = $1 AND (s.id IS NULL OR s.connection_state = 'disconnected' OR p.left_at IS NOT NULL)`, room.roomID)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, ErrUnavailable
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

type postgresRoom struct {
	connection *pgxpool.Conn
	roomID     string
	nodeID     string
}

func (store *PostgresStore) WithRoom(ctx context.Context, roomID string, action func(LockedRoom) error) error {
	connection, err := store.pool.Acquire(ctx)
	if err != nil {
		return ErrUnavailable
	}
	defer connection.Release()
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1, 732))`, roomID); err != nil {
		_ = connection.Conn().Close(context.Background())
		return ErrUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if _, err := connection.Exec(cleanup, `SELECT pg_advisory_unlock(hashtextextended($1, 732))`, roomID); err != nil {
			_ = connection.Conn().Close(cleanup)
		}
	}()
	return action(&postgresRoom{connection: connection, roomID: roomID, nodeID: store.signalingNodeID})
}

func (room *postgresRoom) Load(ctx context.Context) (Scope, *RoomState, error) {
	scope := Scope{RoomID: room.roomID}
	var encoded []byte
	err := room.connection.QueryRow(ctx, `SELECT r.project_id, r.environment_id, m.state FROM room r LEFT JOIN rtc_runtime m ON m.room_id = r.id WHERE r.id = $1`, room.roomID).Scan(&scope.ProjectID, &scope.EnvironmentID, &encoded)
	if errors.Is(err, pgx.ErrNoRows) {
		return Scope{}, nil, ErrForbidden
	}
	if err != nil {
		return Scope{}, nil, ErrUnavailable
	}
	state := &RoomState{Sessions: map[string]*SessionState{}}
	if len(encoded) != 0 && json.Unmarshal(encoded, state) != nil {
		return Scope{}, nil, ErrUnavailable
	}
	return scope, state, nil
}

func (room *postgresRoom) Joined(ctx context.Context, claims auth.Claims, sessionID string) error {
	var joined bool
	err := room.connection.QueryRow(ctx, `SELECT EXISTS (
 SELECT 1 FROM participant_session s JOIN participant p ON p.id = s.participant_id JOIN room r ON r.id = p.room_id
 JOIN environment e ON e.id = r.environment_id JOIN project pr ON pr.id = r.project_id
 JOIN organization o ON o.id = pr.organization_id
 WHERE s.id = $1 AND p.id = $2 AND r.id = $3 AND r.project_id = $4 AND r.environment_id = $5
 AND (left(p.id,7)<>'guestp_' OR guest_token_authorized(p.id,$7)) AND s.signaling_node_id = $6 AND s.connection_state = 'connected' AND p.left_at IS NULL
 AND r.status IN ('created', 'active') AND r.ended_at IS NULL AND e.status = 'active' AND pr.status = 'active' AND o.status = 'active'
 AND (s.signaling_instance_id IS NULL OR EXISTS (SELECT 1 FROM signaling_node_lease l
 WHERE l.instance_id = s.signaling_instance_id AND l.node_id = s.signaling_node_id AND l.expires_at > now()))
)`, sessionID, claims.ParticipantID, room.roomID, claims.ProjectID, claims.EnvironmentID, room.nodeID, claims.TokenID).Scan(&joined)
	if err != nil {
		return ErrUnavailable
	}
	if !joined {
		return ErrForbidden
	}
	return nil
}

func (room *postgresRoom) Save(ctx context.Context, state *RoomState) error {
	encoded, err := json.Marshal(state)
	if err != nil || len(encoded) > 8_388_608 {
		return ErrUnavailable
	}
	webhookEvents := []byte("[]")
	if len(state.PendingWebhookEvents) > 0 {
		webhookEvents, err = json.Marshal(state.PendingWebhookEvents)
		if err != nil {
			return ErrUnavailable
		}
	}
	_, err = room.connection.Exec(ctx, `WITH saved AS (
 INSERT INTO rtc_runtime (room_id, state) VALUES ($1, $2::jsonb)
 ON CONFLICT (room_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now() RETURNING room_id
 ) SELECT publish_webhook_event('rtc:' || saved.room_id || ':' || (e.value->>'ID'), saved.room_id, e.value->>'Type',
 (e.value->>'SentAt')::timestamptz, coalesce(e.value->'Payload', '{}'::jsonb) || jsonb_build_object('roomId', saved.room_id))
 FROM saved CROSS JOIN jsonb_array_elements($3::jsonb) e`, room.roomID, string(encoded), string(webhookEvents))
	if err != nil {
		return ErrUnavailable
	}
	state.PendingWebhookEvents = nil
	return nil
}

func (room *postgresRoom) Assign(ctx context.Context, sessionID, nodeID string) error {
	_, err := room.connection.Exec(ctx, `UPDATE participant_session SET media_node_id = $2 WHERE id = $1`, sessionID, nodeID)
	if err != nil {
		return ErrUnavailable
	}
	return nil
}

func (store *PostgresStore) ReadEvents(ctx context.Context, roomID string, after uint64) ([]RuntimeEvent, uint64, error) {
	var sequence uint64
	var encoded []byte
	err := store.pool.QueryRow(ctx, `SELECT coalesce((state->>'Sequence')::bigint, 0),
 coalesce((SELECT jsonb_agg(e.value ORDER BY (e.value->>'Sequence')::bigint)
 FROM jsonb_array_elements(coalesce(state->'Events', '[]'::jsonb)) e
 WHERE (e.value->>'Sequence')::bigint > $2), '[]'::jsonb)
 FROM rtc_runtime WHERE room_id = $1`, roomID, after).Scan(&sequence, &encoded)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, ErrUnavailable
	}
	var events []RuntimeEvent
	if json.Unmarshal(encoded, &events) != nil {
		return nil, 0, ErrUnavailable
	}
	return events, sequence, nil
}
