package session

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
	"time"
)

func (store *Store) Lifecycle(ctx context.Context, claims auth.Claims) (json.RawMessage, error) {
	var value json.RawMessage
	err := store.pool.QueryRow(ctx, `SELECT read_room_lifecycle(r.id) FROM room r JOIN participant p ON p.room_id=r.id
 WHERE r.id=$1 AND r.project_id=$2 AND r.environment_id=$3 AND p.id=$4 AND p.removed_at IS NULL AND p.left_at IS NULL`, claims.RoomID, claims.ProjectID, claims.EnvironmentID, claims.ParticipantID).Scan(&value)
	return value, err
}

func (store *Store) UpdateLifecycle(ctx context.Context, claims auth.Claims, sessionID string, version int, locked bool, endsAt *time.Time, correlationID string) (json.RawMessage, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SET LOCAL lock_timeout='2s'`); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SET LOCAL statement_timeout='5s'`); err != nil {
		return nil, err
	}
	if err = requireActiveEnvironment(ctx, tx, claims.ProjectID, claims.EnvironmentID); err != nil {
		return nil, err
	}
	var active bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM participant_session s JOIN participant p ON p.id=s.participant_id JOIN room r ON r.id=p.room_id
 WHERE s.id=$1 AND p.id=$2 AND r.id=$3 AND r.project_id=$4 AND r.environment_id=$5
 AND s.connection_state='connected' AND p.left_at IS NULL AND p.removed_at IS NULL AND now()<$6)`, sessionID, claims.ParticipantID, claims.RoomID, claims.ProjectID, claims.EnvironmentID, claims.ExpiresAt.Time).Scan(&active)
	if err != nil {
		return nil, err
	}
	if !active {
		return nil, errors.New("ROOM_LIFECYCLE_FORBIDDEN")
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('relayrtc.audit_actor_type','PARTICIPANT',true),set_config('relayrtc.audit_actor_id',$1,true),set_config('relayrtc.audit_actor_name','Room participant',true),set_config('relayrtc.audit_correlation_id',$2,true)`, claims.ParticipantID, correlationID); err != nil {
		return nil, err
	}
	var value json.RawMessage
	err = tx.QueryRow(ctx, `SELECT update_room_lifecycle($1,$2,$3,$4,$5)`, claims.RoomID, version, locked, endsAt, claims.ParticipantID).Scan(&value)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return value, nil
}
