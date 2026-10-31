package connection

import (
	"context"
	"time"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
	"github.com/relayrtc/relayrtc/services/signaling/internal/rtc"
)

func (handler *Handler) acceptWithTracks(client *client, claims auth.Claims, sessionID, requestID, kind string, payload map[string]any) error {
	ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
	active := handler.sessionActive(ctx, claims.RoomID, claims.ParticipantID, sessionID)
	cancel()
	if !active {
		return rtc.ErrForbidden
	}
	if store, ok := handler.sessionStore.(roomAccessStore); ok {
		ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
		capabilities, err := store.Capabilities(ctx, claims)
		cancel()
		if err != nil {
			return err
		}
		payload["capabilities"] = capabilities
	}
	payload["tracks"] = []any{}
	var sequence uint64
	if discovery, ok := handler.rtcService.(RTCTrackDiscovery); ok {
		ctx, cancel := context.WithTimeout(handler.shutdown, 10*time.Second)
		defer cancel()
		tracks, cursor, err := discovery.Discover(ctx, claims, sessionID)
		if err != nil {
			return err
		}
		payload["tracks"], sequence = tracks, cursor
	}
	client.mu.Lock()
	err := client.writeLocked(map[string]any{"v": 1, "id": newID("msg"), "requestId": requestID, "sentAt": time.Now().UTC(), "type": kind, "payload": payload})
	if err == nil {
		client.rtcCursor, client.rtcReady = sequence, true
	}
	client.mu.Unlock()
	if err == nil {
		handler.startRTCEvents()
	}
	return err
}

func (handler *Handler) startRTCEvents() {
	discovery, ok := handler.rtcService.(RTCTrackDiscovery)
	if !ok {
		return
	}
	handler.rtcEventsOnce.Do(func() {
		handler.wg.Add(1)
		go func() {
			defer handler.wg.Done()
			ticker := time.NewTicker(250 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-handler.shutdown.Done():
					return
				case <-ticker.C:
					handler.deliverRTCEvents(discovery)
				}
			}
		}()
	})
}

func (handler *Handler) deliverRTCEvents(discovery RTCTrackDiscovery) {
	handler.activitySnapshots.Range(func(key, value any) bool {
		if roomID, ok := key.(string); ok && len(handler.registry.roomClients(roomID)) == 0 {
			handler.activitySnapshots.Delete(key)
		}
		return true
	})
	handler.registry.mu.RLock()
	rooms := make([]string, 0, len(handler.registry.rooms))
	for roomID, clients := range handler.registry.rooms {
		if len(clients) != 0 {
			rooms = append(rooms, roomID)
		}
	}
	handler.registry.mu.RUnlock()
	for _, roomID := range rooms {
		clients := handler.registry.roomClients(roomID)
		var after uint64
		ready := false
		for _, client := range clients {
			client.mu.Lock()
			if client.rtcReady && (!ready || client.rtcCursor < after) {
				after, ready = client.rtcCursor, true
			}
			client.mu.Unlock()
		}
		if !ready {
			continue
		}
		if runtime, ok := handler.rtcService.(interface {
			ReconcileAccess(context.Context, string) error
		}); ok {
			ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
			err := runtime.ReconcileAccess(ctx, roomID)
			cancel()
			if err != nil {
				continue
			}
		}
		ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
		events, sequence, err := discovery.Events(ctx, roomID, after)
		cancel()
		if err != nil {
			continue
		}
		for _, client := range clients {
			if !client.deliverRTC(events, sequence) {
				client.close(4003, "RTC state changed; resume the session")
				_ = client.connection.Close()
			}
		}
	}
}

func (client *client) deliverRTC(events []rtc.RuntimeEvent, sequence uint64) bool {
	client.mu.Lock()
	defer client.mu.Unlock()
	if !client.rtcReady {
		return true
	}
	if sequence < client.rtcCursor {
		return true
	}
	if sequence > client.rtcCursor && (len(events) == 0 || events[0].Sequence > client.rtcCursor+1) {
		return false
	}
	for _, change := range events {
		if change.Sequence <= client.rtcCursor {
			continue
		}
		if change.SessionID == "" || change.SessionID == client.rtcSessionID {
			message := map[string]any{"v": 1, "id": change.ID, "sentAt": change.SentAt, "type": change.Type, "payload": change.Payload}
			if change.RequestID != "" {
				message["requestId"] = change.RequestID
			}
			if client.writeLocked(message) != nil {
				return false
			}
		}
		client.rtcCursor = change.Sequence
	}
	return true
}
