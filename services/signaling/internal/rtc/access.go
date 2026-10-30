package rtc

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/url"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

func publicationPermission(trackType string) string {
	switch trackType {
	case "audio":
		return "audio:publish"
	case "camera_video":
		return "video:publish"
	case "screen_video", "screen_audio":
		return "screen:publish"
	default:
		return ""
	}
}

type accessReader interface {
	AllowedPermissions(context.Context, string) ([]string, error)
}

func (room *postgresRoom) AllowedPermissions(ctx context.Context, participantID string) ([]string, error) {
	var allowed []string
	err := room.connection.QueryRow(ctx, `SELECT allowed_permissions FROM participant WHERE id=$1 AND room_id=$2 AND removed_at IS NULL`, participantID, room.roomID).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return []string{}, nil
	}
	if err != nil {
		return nil, ErrUnavailable
	}
	return allowed, nil
}

func effectiveClaims(ctx context.Context, room LockedRoom, claims auth.Claims) (auth.Claims, error) {
	reader, ok := room.(accessReader)
	if !ok {
		return claims, nil
	}
	allowed, err := reader.AllowedPermissions(ctx, claims.ParticipantID)
	if err != nil {
		return claims, err
	}
	if allowed != nil {
		filtered := []string{}
		for _, permission := range claims.Permissions {
			if permitted(allowed, permission) {
				filtered = append(filtered, permission)
			}
		}
		claims.Permissions = filtered
	}
	return claims, nil
}

func (adapter *Adapter) revokePublications(ctx context.Context, room LockedRoom, scope Scope, state *RoomState) error {
	reader, ok := room.(accessReader)
	if !ok {
		return nil
	}
	for sessionID, session := range state.Sessions {
		if session.Ended || len(session.Tracks) == 0 {
			continue
		}
		allowed, err := reader.AllowedPermissions(ctx, session.ParticipantID)
		if err != nil {
			return err
		}
		if allowed == nil {
			continue
		}
		scope.SessionID, scope.MediaParticipantID, scope.ParticipantID = sessionID, sessionID, session.ParticipantID
		for _, track := range session.Tracks {
			if permitted(allowed, publicationPermission(track.Type)) {
				continue
			}
			if err := adapter.checkCleanupNode(ctx, scope); err != nil {
				return err
			}
			command := Command{Method: "DELETE", Path: "/internal/v1/rooms/" + url.PathEscape(scope.RoomID) + "/participants/" + url.PathEscape(sessionID) + "/tracks/" + url.PathEscape(track.MediaID), Scope: scope, Request: Operation{Operation: "track.remove"}}
			if _, err := adapter.media.Execute(ctx, command); err != nil && !missing(err) {
				return err
			}
			retireTrack(state, track, "", "permission_revoked")
			if err := room.Save(ctx, state); err != nil {
				return err
			}
		}
	}
	return nil
}

func (adapter *Adapter) ReconcileAccess(ctx context.Context, roomID string) error {
	return adapter.store.WithRoom(ctx, roomID, func(room LockedRoom) error {
		scope, state, err := room.Load(ctx)
		if err != nil {
			return err
		}
		if !state.Ready {
			return nil
		}
		if state.MediaNodeID != adapter.nodeID {
			return ErrUnavailable
		}
		scope.MediaNodeID, scope.Generation = state.MediaNodeID, state.Generation
		return adapter.revokePublications(ctx, room, scope, state)
	})
}
