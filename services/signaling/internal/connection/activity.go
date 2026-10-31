package connection

import (
	"context"
	"encoding/json"
	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
	"github.com/relayrtc/relayrtc/services/signaling/internal/session"
	"sync"
	"time"
)

type roomActivityStore interface {
	RoomActivity(context.Context, string) (json.RawMessage, error)
	UpdateActivity(context.Context, auth.Claims, string, session.ActivityPreferences, bool, bool) error
}
type activityCache struct {
	mu    sync.Mutex
	at    time.Time
	value json.RawMessage
}

func (handler *Handler) activitySnapshot(ctx context.Context, roomID string) (json.RawMessage, error) {
	store, ok := handler.sessionStore.(roomActivityStore)
	if !ok {
		return nil, nil
	}
	entry, _ := handler.activitySnapshots.LoadOrStore(roomID, &activityCache{})
	cache := entry.(*activityCache)
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if time.Since(cache.at) < 250*time.Millisecond {
		return cache.value, nil
	}
	value, err := store.RoomActivity(ctx, roomID)
	if err != nil {
		return nil, err
	}
	cache.value = value
	cache.at = time.Now()
	return value, nil
}

func (handler *Handler) refreshActivity(client *client, claims auth.Claims, joined *joinedSession) error {
	ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
	defer cancel()
	value, err := handler.activitySnapshot(ctx, claims.RoomID)
	if err != nil || len(value) == 0 {
		return err
	}
	var snapshot map[string]any
	if err = json.Unmarshal(value, &snapshot); err != nil {
		return err
	}
	delete(snapshot, "observedAt")
	key := stringJSON(snapshot)
	if time.Since(joined.activitySentAt) >= 250*time.Millisecond && (joined.activityKey != key || time.Since(joined.activitySentAt) >= 2*time.Second) {
		joined.activityKey = key
		joined.activitySentAt = time.Now()
		return client.write(event("room.activity.changed", value))
	}
	return nil
}

func (handler *Handler) handleActivity(client *client, claims auth.Claims, joined *joinedSession, request requestEnvelope) {
	store, ok := handler.sessionStore.(roomActivityStore)
	if !ok || joined == nil {
		client.protocolError(request.ID, "forbidden", "Join a room before reading activity")
		return
	}
	var payload struct {
		RoomID        string `json:"roomId"`
		SessionID     string `json:"sessionId"`
		Mode          string `json:"mode"`
		ShareActivity *bool  `json:"shareActivity"`
		ShareSpeaking *bool  `json:"shareSpeaking"`
		Visible       *bool  `json:"visible"`
		Active        *bool  `json:"active"`
	}
	if json.Unmarshal(request.Payload, &payload) != nil || payload.RoomID != claims.RoomID || payload.SessionID != joined.session.ID {
		client.protocolError(request.ID, "invalid_message", "The activity request is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(handler.shutdown, 3*time.Second)
	defer cancel()
	if request.Type == "participant.activity.update" {
		if time.Since(joined.activityUpdatedAt) < time.Second {
			client.protocolError(request.ID, "rate_limited", "Wait a second before updating activity again")
			return
		}
		if (payload.Mode != "auto" && payload.Mode != "away") || payload.ShareActivity == nil || payload.ShareSpeaking == nil || payload.Visible == nil || payload.Active == nil {
			client.protocolError(request.ID, "invalid_message", "Send complete activity preferences")
			return
		}
		joined.activityUpdatedAt = time.Now()
		preferences := session.ActivityPreferences{Mode: payload.Mode, ShareActivity: *payload.ShareActivity, ShareSpeaking: *payload.ShareSpeaking}
		if err := store.UpdateActivity(ctx, claims, joined.session.ID, preferences, *payload.Visible, *payload.Active); err != nil {
			client.protocolError(request.ID, "forbidden", "Activity update is unavailable")
			return
		}
		handler.activitySnapshots.Delete(claims.RoomID)
		client.response(request.ID, "participant.activity.updated", preferences)
	} else {
		value, err := handler.activitySnapshot(ctx, claims.RoomID)
		if err != nil {
			client.protocolError(request.ID, "temporarily_unavailable", "Activity is temporarily unavailable")
			return
		}
		client.response(request.ID, "room.activity", value)
	}
	_ = handler.refreshActivity(client, claims, joined)
}
