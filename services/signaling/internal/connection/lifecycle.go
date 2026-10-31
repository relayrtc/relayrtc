package connection

import (
	"context"
	"encoding/json"
	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
	"strings"
	"time"
)

type roomLifecycleStore interface {
	Lifecycle(context.Context, auth.Claims) (json.RawMessage, error)
	UpdateLifecycle(context.Context, auth.Claims, string, int, bool, *time.Time, string) (json.RawMessage, error)
}

func (handler *Handler) refreshLifecycle(client *client, claims auth.Claims, joined *joinedSession) error {
	store, ok := handler.sessionStore.(roomLifecycleStore)
	if !ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
	defer cancel()
	value, err := store.Lifecycle(ctx, claims)
	if err != nil {
		return err
	}
	var state map[string]any
	if err = json.Unmarshal(value, &state); err != nil {
		return err
	}
	delete(state, "serverTime")
	key := stringJSON(state)
	if joined.lifecycleKey != key {
		joined.lifecycleKey = key
		return client.write(event("room.lifecycle.changed", value))
	}
	return nil
}

func (handler *Handler) handleLifecycle(client *client, claims auth.Claims, joined *joinedSession, request requestEnvelope) {
	store, ok := handler.sessionStore.(roomLifecycleStore)
	if !ok || joined == nil {
		client.protocolError(request.ID, "forbidden", "Join the room before accessing its lifecycle")
		return
	}
	var payload struct {
		RoomID    string          `json:"roomId"`
		SessionID string          `json:"sessionId"`
		Version   int             `json:"version"`
		Locked    *bool           `json:"locked"`
		EndsAt    json.RawMessage `json:"endsAt"`
	}
	if json.Unmarshal(request.Payload, &payload) != nil || payload.RoomID != claims.RoomID || payload.SessionID != joined.session.ID {
		client.protocolError(request.ID, "invalid_message", "The room lifecycle request is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(handler.shutdown, 7*time.Second)
	defer cancel()
	var value json.RawMessage
	var err error
	responseType := "room.lifecycle"
	if request.Type == "room.lifecycle.update" {
		var endsAt *time.Time
		if payload.Version < 1 || payload.Version > 2147483646 || payload.Locked == nil || len(payload.EndsAt) == 0 || json.Unmarshal(payload.EndsAt, &endsAt) != nil {
			client.protocolError(request.ID, "invalid_message", "Send a complete versioned lifecycle policy")
			return
		}
		value, err = store.UpdateLifecycle(ctx, claims, joined.session.ID, payload.Version, *payload.Locked, endsAt, request.ID)
		responseType = "room.lifecycle.updated"
	} else {
		value, err = store.Lifecycle(ctx, claims)
	}
	if err != nil {
		code := "internal_error"
		if strings.Contains(err.Error(), "ROOM_LIFECYCLE_CONFLICT") {
			code = "conflict"
		} else if strings.Contains(err.Error(), "ROOM_") {
			code = "forbidden"
		}
		client.protocolError(request.ID, code, "Room lifecycle request failed; reload the current policy before retrying")
		return
	}
	client.response(request.ID, responseType, value)
	_ = handler.refreshLifecycle(client, claims, joined)
}
