package session

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

type ActivityPreferences struct {
	Mode          string `json:"mode"`
	ShareActivity bool   `json:"shareActivity"`
	ShareSpeaking bool   `json:"shareSpeaking"`
}

func (store *Store) RoomActivity(ctx context.Context, roomID string) (json.RawMessage, error) {
	var value json.RawMessage
	err := store.pool.QueryRow(ctx, `SELECT read_room_activity($1)`, roomID).Scan(&value)
	return value, err
}

func (store *Store) UpdateActivity(ctx context.Context, claims auth.Claims, sessionID string, preferences ActivityPreferences, visible, active bool) error {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SET LOCAL statement_timeout='2s'`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT room_id FROM room_activity_policy WHERE room_id=$1 FOR SHARE`, claims.RoomID); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE participant_activity a SET mode=$1,share_activity=$2,share_speaking=$3,visible=$4,
 heartbeat_at=CASE WHEN $2 AND policy.activity_enabled THEN now() ELSE NULL END,
 last_input_at=CASE WHEN NOT $2 OR NOT policy.activity_enabled THEN NULL WHEN $4 AND $5 THEN now() ELSE a.last_input_at END
 FROM participant p JOIN room r ON r.id=p.room_id JOIN room_activity_policy policy ON policy.room_id=r.id
 JOIN participant_session s ON s.participant_id=p.id JOIN project pr ON pr.id=r.project_id
 JOIN organization o ON o.id=pr.organization_id JOIN environment e ON e.id=r.environment_id AND e.project_id=pr.id
 WHERE a.participant_id=p.id AND p.id=$6 AND r.id=$7 AND r.project_id=$8 AND r.environment_id=$9
 AND p.left_at IS NULL AND p.removed_at IS NULL AND s.id=$10 AND s.connection_state='connected'
 AND r.status='active' AND pr.status='active' AND o.status='active' AND e.status='active' AND now()<$11
 AND (s.signaling_instance_id IS NULL OR EXISTS(SELECT 1 FROM signaling_node_lease l WHERE l.instance_id=s.signaling_instance_id AND l.node_id=s.signaling_node_id AND l.expires_at>now()))`, preferences.Mode, preferences.ShareActivity, preferences.ShareSpeaking, visible, active, claims.ParticipantID, claims.RoomID, claims.ProjectID, claims.EnvironmentID, sessionID, claims.ExpiresAt.Time)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("participant activity is unavailable")
	}
	return tx.Commit(ctx)
}
