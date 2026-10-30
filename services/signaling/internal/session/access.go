package session

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

type Capabilities struct {
	RoomID               string   `json:"roomId"`
	ParticipantID        string   `json:"participantId"`
	Role                 string   `json:"role"`
	Version              int      `json:"version"`
	Permissions          []string `json:"permissions"`
	CanManageRoles       bool     `json:"canManageRoles"`
	CanManagePermissions bool     `json:"canManagePermissions"`
}

func (store *Store) Capabilities(ctx context.Context, claims auth.Claims) (Capabilities, error) {
	result := Capabilities{RoomID: claims.RoomID, ParticipantID: claims.ParticipantID, Permissions: []string{}}
	var allowed []string
	err := store.pool.QueryRow(ctx, `SELECT p.role, p.access_version, p.allowed_permissions FROM participant p
 JOIN room r ON r.id = p.room_id WHERE p.id = $1 AND p.room_id = $2 AND r.project_id = $3 AND r.environment_id = $4
 AND p.removed_at IS NULL AND p.left_at IS NULL AND r.status IN ('created','active')
 AND EXISTS(SELECT 1 FROM room_lifecycle l WHERE l.room_id=r.id AND (l.ends_at IS NULL OR l.ends_at>now()))`, claims.ParticipantID, claims.RoomID, claims.ProjectID, claims.EnvironmentID).Scan(&result.Role, &result.Version, &allowed)
	if err != nil {
		return Capabilities{}, err
	}
	if strings.HasPrefix(claims.ParticipantID, "guestp_") || (result.Role != "host" && result.Role != "moderator") {
		result.Role = "participant"
	}
	for _, permission := range claims.Permissions {
		if allowed == nil || containsPermission(allowed, permission) {
			result.Permissions = append(result.Permissions, permission)
		}
	}
	result.CanManageRoles = result.Role == "host"
	result.CanManagePermissions = result.Role == "host" || result.Role == "moderator"
	return result, nil
}

func containsPermission(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func (store *Store) UpdateAccess(ctx context.Context, claims auth.Claims, sessionID, targetID string, version int, role string, permissions []string, correlationID string) (json.RawMessage, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SET LOCAL lock_timeout='2s'`); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,732))`, claims.RoomID); err != nil {
		return nil, err
	}
	var active bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM participant_session s JOIN participant p ON p.id=s.participant_id
 JOIN room r ON r.id=p.room_id WHERE s.id=$1 AND p.id=$2 AND p.room_id=$3 AND r.project_id=$4 AND r.environment_id=$5
 AND r.status IN ('created','active') AND r.ended_at IS NULL
 AND EXISTS(SELECT 1 FROM project pr JOIN organization o ON o.id=pr.organization_id JOIN environment e ON e.project_id=pr.id
 WHERE pr.id=r.project_id AND e.id=r.environment_id AND pr.status='active' AND e.status='active' AND o.status='active')
 AND now() < $6 AND s.connection_state='connected' AND p.left_at IS NULL AND p.removed_at IS NULL
 AND (s.signaling_instance_id IS NULL OR EXISTS(SELECT 1 FROM signaling_node_lease l WHERE l.instance_id=s.signaling_instance_id
 AND l.node_id=s.signaling_node_id AND l.expires_at>now())))`, sessionID, claims.ParticipantID, claims.RoomID, claims.ProjectID, claims.EnvironmentID, claims.ExpiresAt.Time).Scan(&active)
	if err != nil {
		return nil, err
	}
	if !active {
		return nil, errors.New("ROOM_ACCESS_FORBIDDEN")
	}
	_, err = tx.Exec(ctx, `SELECT set_config('relayrtc.audit_actor_type','PARTICIPANT',true),
 set_config('relayrtc.audit_actor_id',$1,true), set_config('relayrtc.audit_actor_name','Room participant',true),
 set_config('relayrtc.audit_correlation_id',$2,true)`, claims.ParticipantID, correlationID)
	if err != nil {
		return nil, err
	}
	var result json.RawMessage
	err = tx.QueryRow(ctx, `SELECT update_room_participant_access($1,$2,$3,$4,$5,$6)`, claims.RoomID, targetID, version, role, permissions, claims.ParticipantID).Scan(&result)
	if err != nil {
		_ = tx.Rollback(ctx)
		if strings.Contains(err.Error(), "ROOM_") || strings.Contains(err.Error(), "PARTICIPANT_NOT_FOUND") {
			_, auditErr := store.pool.Exec(ctx, `INSERT INTO audit_event(id,actor_type,actor_id,actor_name,organization_id,room_id,
              resource_type,resource_id,action,outcome,correlation_id,metadata)
              SELECT gen_random_uuid()::text,'PARTICIPANT',$1,'Room participant',pr.organization_id,r.id,
                'participant',$2,'room.participant_access_denied','FAILURE',$3,'{}'::jsonb
              FROM room r JOIN project pr ON pr.id=r.project_id
              WHERE r.id=$4 AND r.project_id=$5 AND r.environment_id=$6`, claims.ParticipantID, targetID, correlationID, claims.RoomID, claims.ProjectID, claims.EnvironmentID)
			return nil, errors.Join(err, auditErr)
		}
		return nil, err
	}
	return result, tx.Commit(ctx)
}

func (store *Store) ReadAccess(ctx context.Context, roomID, participantID string) (json.RawMessage, error) {
	var result json.RawMessage
	err := store.pool.QueryRow(ctx, `SELECT room_participant_access(p) FROM participant p WHERE room_id=$1 AND id=$2 AND removed_at IS NULL`, roomID, participantID).Scan(&result)
	return result, err
}
