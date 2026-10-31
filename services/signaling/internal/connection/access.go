package connection

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
	"github.com/relayrtc/relayrtc/services/signaling/internal/session"
)

type roomAccessStore interface {
	ReadAccess(context.Context, string, string) (json.RawMessage, error)
	Capabilities(context.Context, auth.Claims) (session.Capabilities, error)
	UpdateAccess(context.Context, auth.Claims, string, string, int, string, []string, string) (json.RawMessage, error)
}

func (handler *Handler) refreshAccess(client *client, claims auth.Claims, joined *joinedSession) (session.Capabilities, error) {
	if err := handler.refreshLifecycle(client, claims, joined); err != nil {
		return session.Capabilities{}, err
	}
	store, ok := handler.sessionStore.(roomAccessStore)
	if !ok {
		return session.Capabilities{}, nil
	}
	ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
	defer cancel()
	capabilities, err := store.Capabilities(ctx, claims)
	if err != nil {
		return capabilities, err
	}
	if joined.accessKey != stringJSON(capabilities) {
		joined.accessKey = stringJSON(capabilities)
		joined.participant.Role = capabilities.Role
		if err := client.write(event("room.capabilities.changed", capabilities)); err != nil {
			return capabilities, err
		}
		handler.registry.broadcast(claims.RoomID, client, event("participant.metadata.updated", map[string]any{"participant": joined.participant}))
	}
	return capabilities, nil
}

func stringJSON(value any) string { encoded, _ := json.Marshal(value); return string(encoded) }

func (handler *Handler) handleAccessUpdate(client *client, claims auth.Claims, joined *joinedSession, request requestEnvelope) {
	store, ok := handler.sessionStore.(roomAccessStore)
	if !ok || joined == nil {
		client.protocolError(request.ID, "forbidden", "Room access management is unavailable")
		return
	}
	var payload struct {
		RoomID             string          `json:"roomId"`
		SessionID          string          `json:"sessionId"`
		ParticipantID      string          `json:"participantId"`
		Version            int             `json:"version"`
		Role               string          `json:"role"`
		AllowedPermissions json.RawMessage `json:"allowedPermissions"`
	}
	if json.Unmarshal(request.Payload, &payload) != nil || payload.RoomID != claims.RoomID || payload.SessionID != joined.session.ID || payload.ParticipantID == "" || len(payload.ParticipantID) > 128 || payload.Version < 1 || payload.Version > 2147483646 || len(payload.AllowedPermissions) == 0 {
		client.protocolError(request.ID, "invalid_message", "The room access update is invalid")
		return
	}
	var permissions []string
	if json.Unmarshal(payload.AllowedPermissions, &permissions) != nil || (permissions != nil && (!hasPermission(permissions, "room:join") || len(permissions) > 6)) {
		client.protocolError(request.ID, "invalid_message", "The permission policy is invalid")
		return
	}
	for i, permission := range permissions {
		if !hasPermission([]string{"room:join", "audio:publish", "video:publish", "screen:publish", "messages:send", "metadata:update"}, permission) || hasPermission(permissions[:i], permission) {
			client.protocolError(request.ID, "invalid_message", "The permission policy is invalid")
			return
		}
	}
	ctx, cancel := context.WithTimeout(handler.shutdown, 10*time.Second)
	defer cancel()
	access, err := store.UpdateAccess(ctx, claims, joined.session.ID, payload.ParticipantID, payload.Version, payload.Role, permissions, request.ID)
	if err != nil {
		code, message := "internal_error", "The access update could not be saved"
		if strings.Contains(err.Error(), "ROOM_ACCESS_CONFLICT") {
			code, message = "conflict", "The access policy changed; reload before saving"
		} else if strings.Contains(err.Error(), "ROOM_") || strings.Contains(err.Error(), "PARTICIPANT_NOT_FOUND") {
			code, message = "forbidden", "The requested access change is unavailable"
		}
		client.protocolError(request.ID, code, message)
		return
	}
	client.response(request.ID, "participant.access.update.accepted", map[string]any{"access": access})
	if runtime, ok := handler.rtcService.(interface {
		ReconcileAccess(context.Context, string) error
	}); ok {
		_ = runtime.ReconcileAccess(ctx, claims.RoomID)
	}
}

func (handler *Handler) handleAccessGet(client *client, claims auth.Claims, joined *joinedSession, request requestEnvelope) {
	store, ok := handler.sessionStore.(roomAccessStore)
	if !ok || joined == nil {
		client.protocolError(request.ID, "forbidden", "Join the room before reading access")
		return
	}
	var payload struct {
		RoomID        string `json:"roomId"`
		SessionID     string `json:"sessionId"`
		ParticipantID string `json:"participantId"`
	}
	if json.Unmarshal(request.Payload, &payload) != nil || payload.RoomID != claims.RoomID || payload.SessionID != joined.session.ID || len(payload.ParticipantID) == 0 || len(payload.ParticipantID) > 128 {
		client.protocolError(request.ID, "invalid_message", "The access request is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
	defer cancel()
	result, err := store.ReadAccess(ctx, claims.RoomID, payload.ParticipantID)
	if err != nil {
		client.protocolError(request.ID, "not_found", "Participant access is unavailable")
		return
	}
	client.response(request.ID, "participant.access", map[string]any{"access": result})
}
