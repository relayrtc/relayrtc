package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

var (
	ErrParticipantConflict = errors.New("participant already joined")
	ErrRoomFull            = errors.New("room is full")
	ErrRoomNotJoinable     = errors.New("room is not joinable")
	ErrSessionNotResumable = errors.New("session is not resumable")
)

type Room struct {
	ID              string          `json:"id"`
	ProjectID       string          `json:"projectId"`
	EnvironmentID   string          `json:"environmentId"`
	Name            string          `json:"name"`
	Metadata        json.RawMessage `json:"metadata"`
	Status          string          `json:"status"`
	MaxParticipants int             `json:"maxParticipants"`
	CreatedAt       time.Time       `json:"createdAt"`
	StartedAt       *time.Time      `json:"startedAt"`
	EndedAt         *time.Time      `json:"endedAt"`
}

type Participant struct {
	ID         string          `json:"id"`
	RoomID     string          `json:"roomId"`
	ExternalID *string         `json:"externalId"`
	Name       string          `json:"name"`
	Metadata   json.RawMessage `json:"metadata"`
	Role       string          `json:"role"`
	JoinedAt   time.Time       `json:"joinedAt"`
	LeftAt     *time.Time      `json:"leftAt"`
}

type ParticipantSession struct {
	ID              string     `json:"id"`
	ParticipantID   string     `json:"participantId"`
	SignalingNodeID string     `json:"signalingNodeId"`
	MediaNodeID     *string    `json:"mediaNodeId"`
	ConnectionState string     `json:"connectionState"`
	TransportType   string     `json:"transportType"`
	JoinedAt        time.Time  `json:"joinedAt"`
	DisconnectedAt  *time.Time `json:"disconnectedAt"`
	ReconnectedAt   *time.Time `json:"reconnectedAt"`
}

type JoinResult struct {
	Room         Room
	Participant  Participant
	Session      ParticipantSession
	Participants []Participant
}

type ResumeResult struct {
	Participant  Participant
	Session      ParticipantSession
	Participants []Participant
}

type storePool interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type Store struct {
	signalingInstanceID string
	pool                storePool
	locationRetention   time.Duration
}

func NewStore(pool *pgxpool.Pool, locationRetention time.Duration) *Store {
	return &Store{pool: pool, locationRetention: locationRetention}
}

func (store *Store) SetSignalingInstance(instanceID string) {
	store.signalingInstanceID = instanceID
}

func (store *Store) AuthorizeGuest(ctx context.Context, claims auth.Claims) bool {
	if !strings.HasPrefix(claims.ParticipantID, "guestp_") {
		return true
	}
	var ok bool
	err := store.pool.QueryRow(ctx, `SELECT guest_token_authorized($1,$2)`, claims.ParticipantID, claims.TokenID).Scan(&ok)
	return err == nil && ok
}

func (store *Store) IsActive(ctx context.Context, roomID, participantID, sessionID string) (bool, error) {
	var active bool
	err := store.pool.QueryRow(ctx, `SELECT EXISTS (
 SELECT 1 FROM participant_session s JOIN participant p ON p.id = s.participant_id JOIN room r ON r.id = p.room_id
 JOIN environment e ON e.id = r.environment_id JOIN project pr ON pr.id = r.project_id
 JOIN organization o ON o.id = pr.organization_id
 WHERE s.id = $1 AND p.id = $2 AND p.room_id = $3 AND p.left_at IS NULL
 AND (left(p.id,7)<>'guestp_' OR guest_participant_authorized(p.id)) AND s.connection_state = 'connected' AND r.status IN ('created', 'active') AND r.ended_at IS NULL AND e.status = 'active' AND pr.status = 'active' AND o.status = 'active'
 AND (s.signaling_instance_id IS NULL OR EXISTS (SELECT 1 FROM signaling_node_lease l
 WHERE l.instance_id = s.signaling_instance_id AND l.node_id = s.signaling_node_id AND l.expires_at > now()))
)`, sessionID, participantID, roomID).Scan(&active)
	return active, err
}

func (store *Store) RecordUsageSample(ctx context.Context, sessionID, sampleID string, messagesIn, messagesOut int64) error {
	if sampleID == "" || messagesIn < 0 || messagesOut < 0 {
		return errors.New("invalid signaling usage sample")
	}
	_, err := store.pool.Exec(ctx, `
        WITH accepted AS (
            INSERT INTO signaling_usage_sample (id, session_id) VALUES ($2, $1)
            ON CONFLICT (id) DO NOTHING RETURNING session_id
        )
        UPDATE participant_session s
        SET messages_in = s.messages_in + $3, messages_out = s.messages_out + $4
        FROM accepted WHERE s.id = accepted.session_id`, sessionID, sampleID, messagesIn, messagesOut)
	if err != nil {
		return fmt.Errorf("record signaling usage: %w", err)
	}
	return nil
}

func (store *Store) SetLocation(ctx context.Context, sessionID, clientIP, countryCode, country string) error {
	_, err := store.pool.Exec(ctx, `
		UPDATE participant_session
		SET client_ip = NULLIF($2, ''), country_code = NULLIF($3, ''), country = NULLIF($4, '')
		WHERE id = $1 AND joined_at >= $5`, sessionID, clientIP, countryCode, country, time.Now().Add(-store.locationRetention))
	if err != nil {
		return fmt.Errorf("record participant location: %w", err)
	}
	return nil
}

func (store *Store) Join(ctx context.Context, claims auth.Claims, sessionID, nodeID string) (JoinResult, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return JoinResult{}, fmt.Errorf("begin join transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if strings.HasPrefix(claims.ParticipantID, "guestp_") {
		var allowed bool
		if err := tx.QueryRow(ctx, `SELECT guest_token_authorized($1,$2)`, claims.ParticipantID, claims.TokenID).Scan(&allowed); err != nil || !allowed {
			return JoinResult{}, ErrRoomNotJoinable
		}
	}

	if err := requireActiveEnvironment(ctx, tx, claims.ProjectID, claims.EnvironmentID); err != nil {
		return JoinResult{}, err
	}

	room, err := selectRoom(ctx, tx, claims.RoomID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return JoinResult{}, ErrRoomNotJoinable
		}
		return JoinResult{}, err
	}
	if room.ProjectID != claims.ProjectID || room.EnvironmentID != claims.EnvironmentID ||
		(room.Status != "created" && room.Status != "active") {
		return JoinResult{}, ErrRoomNotJoinable
	}

	// Recheck after the room lock, so a concurrent revocation cannot consume a seat.
	if strings.HasPrefix(claims.ParticipantID, "guestp_") {
		var allowed bool
		if err := tx.QueryRow(ctx, `SELECT guest_token_authorized($1,$2)`, claims.ParticipantID, claims.TokenID).Scan(&allowed); err != nil || !allowed {
			return JoinResult{}, ErrRoomNotJoinable
		}
	}
	var active int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM participant WHERE room_id = $1 AND left_at IS NULL`, room.ID).Scan(&active); err != nil {
		return JoinResult{}, fmt.Errorf("count active participants: %w", err)
	}
	if active >= room.MaxParticipants {
		return JoinResult{}, ErrRoomFull
	}

	metadata, err := json.Marshal(claims.Metadata)
	if err != nil {
		return JoinResult{}, fmt.Errorf("encode participant metadata: %w", err)
	}
	participant := Participant{}
	err = tx.QueryRow(ctx, `
		INSERT INTO participant (id, room_id, name, metadata, role)
		VALUES ($1, $2, $3, $4, 'participant')
		RETURNING id, room_id, external_id, name, metadata, role, joined_at, left_at`,
		claims.ParticipantID, room.ID, claims.ParticipantName, metadata,
	).Scan(
		&participant.ID, &participant.RoomID, &participant.ExternalID, &participant.Name,
		&participant.Metadata, &participant.Role, &participant.JoinedAt, &participant.LeftAt,
	)
	if err != nil {
		if pgxErr := new(pgconn.PgError); errors.As(err, &pgxErr) && pgxErr.Code == "23505" {
			return JoinResult{}, ErrParticipantConflict
		}
		return JoinResult{}, fmt.Errorf("insert participant: %w", err)
	}

	participantSession := ParticipantSession{}
	err = tx.QueryRow(ctx, `
		INSERT INTO participant_session (id, participant_id, signaling_node_id, signaling_instance_id)
		VALUES ($1, $2, $3, NULLIF($4, ''))
		RETURNING id, participant_id, signaling_node_id, media_node_id, connection_state,
		          transport_type, joined_at, disconnected_at, reconnected_at`,
		sessionID, participant.ID, nodeID, store.signalingInstanceID,
	).Scan(
		&participantSession.ID, &participantSession.ParticipantID, &participantSession.SignalingNodeID,
		&participantSession.MediaNodeID, &participantSession.ConnectionState,
		&participantSession.TransportType, &participantSession.JoinedAt,
		&participantSession.DisconnectedAt, &participantSession.ReconnectedAt,
	)
	if err != nil {
		return JoinResult{}, fmt.Errorf("insert participant session: %w", err)
	}

	if err := tx.QueryRow(ctx, `
		UPDATE room SET status = 'active', started_at = COALESCE(started_at, now())
		WHERE id = $1
		RETURNING status, started_at`, room.ID,
	).Scan(&room.Status, &room.StartedAt); err != nil {
		return JoinResult{}, fmt.Errorf("activate room: %w", err)
	}

	participants, err := listParticipants(ctx, tx, room.ID)
	if err != nil {
		return JoinResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return JoinResult{}, fmt.Errorf("commit join transaction: %w", err)
	}
	return JoinResult{Room: room, Participant: participant, Session: participantSession, Participants: participants}, nil
}

func (store *Store) Leave(ctx context.Context, roomID, participantID, sessionID string) (time.Time, error) {
	return store.finalize(ctx, roomID, participantID, sessionID, false)
}

func (store *Store) Disconnect(ctx context.Context, participantID, sessionID string) (time.Time, error) {
	disconnectedAt := time.Now().UTC()
	command, err := store.pool.Exec(ctx, `
		UPDATE participant_session
		SET connection_state = 'reconnecting', disconnected_at = $1,
		    connection_seconds = connection_seconds + greatest(0, extract(epoch from ($1 - coalesce(reconnected_at, joined_at))))
		WHERE id = $2 AND participant_id = $3 AND connection_state = 'connected'`,
		disconnectedAt, sessionID, participantID,
	)
	if err != nil {
		return time.Time{}, fmt.Errorf("mark participant session reconnecting: %w", err)
	}
	if command.RowsAffected() == 0 {
		return time.Time{}, ErrSessionNotResumable
	}
	return disconnectedAt, nil
}

func (store *Store) Resume(
	ctx context.Context,
	claims auth.Claims,
	sessionID, nodeID string,
	notDisconnectedBefore time.Time,
) (ResumeResult, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ResumeResult{}, fmt.Errorf("begin resume transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if strings.HasPrefix(claims.ParticipantID, "guestp_") {
		var allowed bool
		if err := tx.QueryRow(ctx, `SELECT guest_token_authorized($1,$2)`, claims.ParticipantID, claims.TokenID).Scan(&allowed); err != nil || !allowed {
			return ResumeResult{}, ErrSessionNotResumable
		}
	}

	if err := requireActiveEnvironment(ctx, tx, claims.ProjectID, claims.EnvironmentID); err != nil {
		if errors.Is(err, ErrRoomNotJoinable) {
			return ResumeResult{}, ErrSessionNotResumable
		}
		return ResumeResult{}, err
	}

	participant := Participant{}
	session := ParticipantSession{}
	err = tx.QueryRow(ctx, `
		SELECT p.id, p.room_id, p.external_id, p.name, p.metadata, p.role, p.joined_at, p.left_at,
		       s.id, s.participant_id, s.signaling_node_id, s.media_node_id, s.connection_state,
		       s.transport_type, s.joined_at, s.disconnected_at, s.reconnected_at
		FROM participant_session s
		JOIN participant p ON p.id = s.participant_id
		JOIN room r ON r.id = p.room_id
		WHERE s.id = $1 AND s.participant_id = $2 AND p.room_id = $3
		  AND r.project_id = $4 AND r.environment_id = $5
		  AND r.status IN ('created', 'active')
		  AND p.left_at IS NULL AND s.connection_state = 'reconnecting'
		  AND s.disconnected_at >= $6
		FOR UPDATE`,
		sessionID, claims.ParticipantID, claims.RoomID, claims.ProjectID, claims.EnvironmentID,
		notDisconnectedBefore,
	).Scan(
		&participant.ID, &participant.RoomID, &participant.ExternalID, &participant.Name,
		&participant.Metadata, &participant.Role, &participant.JoinedAt, &participant.LeftAt,
		&session.ID, &session.ParticipantID, &session.SignalingNodeID, &session.MediaNodeID,
		&session.ConnectionState, &session.TransportType, &session.JoinedAt,
		&session.DisconnectedAt, &session.ReconnectedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ResumeResult{}, ErrSessionNotResumable
		}
		return ResumeResult{}, fmt.Errorf("select resumable participant session: %w", err)
	}

	if strings.HasPrefix(claims.ParticipantID, "guestp_") {
		var allowed bool
		if err := tx.QueryRow(ctx, `SELECT guest_token_authorized($1,$2)`, claims.ParticipantID, claims.TokenID).Scan(&allowed); err != nil || !allowed {
			return ResumeResult{}, ErrSessionNotResumable
		}
	}
	reconnectedAt := time.Now().UTC()
	err = tx.QueryRow(ctx, `
		UPDATE participant_session
		SET connection_state = 'connected', signaling_node_id = $1, reconnected_at = $2,
		    disconnected_at = NULL, signaling_instance_id = NULLIF($4, '')
		WHERE id = $3 AND connection_state = 'reconnecting'
		RETURNING id, participant_id, signaling_node_id, media_node_id, connection_state,
		          transport_type, joined_at, disconnected_at, reconnected_at`,
		nodeID, reconnectedAt, sessionID, store.signalingInstanceID,
	).Scan(
		&session.ID, &session.ParticipantID, &session.SignalingNodeID, &session.MediaNodeID,
		&session.ConnectionState, &session.TransportType, &session.JoinedAt,
		&session.DisconnectedAt, &session.ReconnectedAt,
	)
	if err != nil {
		return ResumeResult{}, ErrSessionNotResumable
	}
	participants, err := listParticipants(ctx, tx, claims.RoomID)
	if err != nil {
		return ResumeResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResumeResult{}, fmt.Errorf("commit session resume: %w", err)
	}
	return ResumeResult{Participant: participant, Session: session, Participants: participants}, nil
}

func (store *Store) Expire(ctx context.Context, roomID, participantID, sessionID string) (time.Time, error) {
	return store.finalize(ctx, roomID, participantID, sessionID, true)
}

func (store *Store) EndRoom(ctx context.Context, roomID string, endedAt time.Time) error {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin room termination transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		UPDATE participant_session s
		SET connection_seconds = s.connection_seconds + case when s.connection_state = 'connected'
		      then greatest(0, extract(epoch from ($1 - coalesce(s.reconnected_at, s.joined_at)))) else 0 end,
		    connection_state = 'disconnected', disconnected_at = COALESCE(s.disconnected_at, $1)
		FROM participant p
		WHERE s.participant_id = p.id AND p.room_id = $2
		  AND s.connection_state IN ('connected', 'reconnecting')`, endedAt, roomID); err != nil {
		return fmt.Errorf("disconnect ended room sessions: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE participant SET left_at = COALESCE(left_at, $1)
		WHERE room_id = $2 AND left_at IS NULL`, endedAt, roomID); err != nil {
		return fmt.Errorf("leave ended room participants: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit room termination: %w", err)
	}
	return nil
}

func (store *Store) GetRoom(ctx context.Context, roomID string) (Room, error) {
	var room Room
	err := store.pool.QueryRow(ctx, `SELECT id, project_id, environment_id, name, metadata, status,
 max_participants, created_at, started_at, ended_at FROM room WHERE id = $1`, roomID).Scan(
		&room.ID, &room.ProjectID, &room.EnvironmentID, &room.Name, &room.Metadata, &room.Status,
		&room.MaxParticipants, &room.CreatedAt, &room.StartedAt, &room.EndedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Room{}, ErrRoomNotJoinable
	}
	return room, err
}

func (store *Store) UpdateMetadata(
	ctx context.Context,
	roomID, participantID, sessionID string,
	metadata json.RawMessage,
) (Participant, error) {
	participant := Participant{}
	err := store.pool.QueryRow(ctx, `
		UPDATE participant p
		SET metadata = $1
		FROM participant_session s
		WHERE p.id = $2 AND p.room_id = $3 AND p.left_at IS NULL
		  AND s.id = $4 AND s.participant_id = p.id AND s.connection_state = 'connected'
		RETURNING p.id, p.room_id, p.external_id, p.name, p.metadata, p.role,
		          p.joined_at, p.left_at`,
		metadata, participantID, roomID, sessionID,
	).Scan(
		&participant.ID, &participant.RoomID, &participant.ExternalID, &participant.Name,
		&participant.Metadata, &participant.Role, &participant.JoinedAt, &participant.LeftAt,
	)
	if err != nil {
		return Participant{}, fmt.Errorf("update participant metadata: %w", err)
	}
	return participant, nil
}

func (store *Store) finalize(
	ctx context.Context,
	roomID, participantID, sessionID string,
	reconnectingOnly bool,
) (time.Time, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return time.Time{}, fmt.Errorf("begin leave transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	leftAt := time.Now().UTC()
	query := `
		UPDATE participant_session
		SET connection_seconds = connection_seconds + case when connection_state = 'connected'
		      then greatest(0, extract(epoch from ($1 - coalesce(reconnected_at, joined_at)))) else 0 end,
		    connection_state = 'disconnected', disconnected_at = COALESCE(disconnected_at, $1)
		WHERE id = $2 AND participant_id = $3`
	if reconnectingOnly {
		query += ` AND connection_state = 'reconnecting'`
	}
	command, err := tx.Exec(ctx, query, leftAt, sessionID, participantID)
	if err != nil {
		return time.Time{}, fmt.Errorf("disconnect participant session: %w", err)
	}
	if command.RowsAffected() == 0 {
		return time.Time{}, pgx.ErrNoRows
	}
	if _, err := tx.Exec(ctx, `
		UPDATE participant SET left_at = COALESCE(left_at, $1)
		WHERE id = $2 AND room_id = $3`, leftAt, participantID, roomID); err != nil {
		return time.Time{}, fmt.Errorf("leave participant: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return time.Time{}, fmt.Errorf("commit leave transaction: %w", err)
	}
	return leftAt, nil
}

func selectRoom(ctx context.Context, tx pgx.Tx, roomID string) (Room, error) {
	room := Room{}
	err := tx.QueryRow(ctx, `
		SELECT id, project_id, environment_id, name, metadata, status, max_participants,
		       created_at, started_at, ended_at
		FROM room WHERE id = $1 FOR UPDATE`, roomID,
	).Scan(
		&room.ID, &room.ProjectID, &room.EnvironmentID, &room.Name, &room.Metadata,
		&room.Status, &room.MaxParticipants, &room.CreatedAt, &room.StartedAt, &room.EndedAt,
	)
	return room, err
}

func listParticipants(ctx context.Context, tx pgx.Tx, roomID string) ([]Participant, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, room_id, external_id, name, metadata, role, joined_at, left_at
		FROM participant WHERE room_id = $1 AND left_at IS NULL ORDER BY joined_at, id`, roomID)
	if err != nil {
		return nil, fmt.Errorf("list room participants: %w", err)
	}
	defer rows.Close()
	participants := make([]Participant, 0)
	for rows.Next() {
		participant := Participant{}
		if err := rows.Scan(
			&participant.ID, &participant.RoomID, &participant.ExternalID, &participant.Name,
			&participant.Metadata, &participant.Role, &participant.JoinedAt, &participant.LeftAt,
		); err != nil {
			return nil, fmt.Errorf("scan room participant: %w", err)
		}
		participants = append(participants, participant)
	}
	return participants, rows.Err()
}

func requireActiveEnvironment(ctx context.Context, tx pgx.Tx, projectID, environmentID string) error {
	var status string
	err := tx.QueryRow(ctx, `WITH locked_organization AS MATERIALIZED (
  SELECT o.id, o.status FROM organization o
  WHERE o.id = (SELECT organization_id FROM project WHERE id = $1) FOR SHARE OF o
 ), locked_project AS MATERIALIZED (
  SELECT p.id, p.status FROM project p JOIN locked_organization o ON o.id = p.organization_id
  WHERE p.id = $1 FOR SHARE OF p
 ), locked_environment AS MATERIALIZED (
  SELECT e.status FROM environment e JOIN locked_project p ON p.id = e.project_id
  WHERE e.id = $2 FOR SHARE OF e
 ) SELECT p.status FROM locked_project p, locked_organization o, locked_environment e
 WHERE o.status = 'active' AND e.status = 'active'`, projectID, environmentID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRoomNotJoinable
	}
	if err != nil {
		return fmt.Errorf("check environment admission: %w", err)
	}
	if status != "active" {
		return ErrRoomNotJoinable
	}
	return nil
}

func (store *Store) PurgeLocations(ctx context.Context, cutoff time.Time, clearIP bool) error {
	_, err := store.pool.Exec(ctx, `
  UPDATE participant_session
  SET client_ip = CASE WHEN joined_at < $1 OR $2 THEN NULL ELSE client_ip END,
      country_code = CASE WHEN joined_at < $1 THEN NULL ELSE country_code END,
      country = CASE WHEN joined_at < $1 THEN NULL ELSE country END
  WHERE (joined_at < $1 AND (client_ip IS NOT NULL OR country_code IS NOT NULL OR country IS NOT NULL))
     OR ($2 AND client_ip IS NOT NULL)`, cutoff, clearIP)
	if err != nil {
		return fmt.Errorf("purge participant location: %w", err)
	}
	return nil
}
