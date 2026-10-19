package rtc

import (
	"context"
	"encoding/json"
	"net/url"
	"sort"
	"time"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

const negotiationTimeout = time.Minute

func appendEvent(state *RoomState, sessionID, requestID, kind string, payload map[string]any) {
	state.Sequence++
	state.Events = append(state.Events, RuntimeEvent{Sequence: state.Sequence, ID: "msg_" + newID(), SessionID: sessionID, RequestID: requestID, Type: kind, Payload: payload, SentAt: time.Now().UTC()})
	if kind == "track.published" || kind == "track.unpublished" {
		state.PendingWebhookEvents = append(state.PendingWebhookEvents, state.Events[len(state.Events)-1])
	}
	if len(state.Events) > 256 {
		state.Events = state.Events[len(state.Events)-256:]
	}
	for len(state.Events) > 1 {
		encoded, err := json.Marshal(state.Events)
		if err == nil && len(encoded) <= 1_048_576 {
			break
		}
		state.Events = state.Events[1:]
	}
}

func invalidateReceipts(session *SessionState, resourceID string) {
	for id, receipt := range session.Receipts {
		if receipt.Response == nil {
			continue
		}
		payload := receipt.Response.Payload
		track, _ := object(payload, "track")
		if valueString(payload, "subscriptionId") == resourceID || valueString(payload, "transportId") == resourceID || valueString(payload, "trackId") == resourceID || valueString(track, "id") == resourceID {
			receipt.Response, receipt.Failed = nil, true
			session.Receipts[id] = receipt
		}
	}
}

func retireSubscription(state *RoomState, session *SessionState, binding SubscriptionBinding, requestID, reason string) {
	delete(session.Subscriptions, binding.ID)
	invalidateReceipts(session, binding.ID)
	var trackID any = binding.TrackID
	if binding.TrackID == "" {
		trackID = nil
	}
	appendEvent(state, binding.SessionID, requestID, "rtc.subscription.closed", map[string]any{"roomId": binding.RoomID, "sessionId": binding.SessionID, "subscriptionId": binding.ID, "trackId": trackID, "reason": reason})
}

func retireTrack(state *RoomState, binding TrackBinding, requestID, reason string) {
	now := time.Now().UTC()
	binding.State, binding.UnpublishedAt = "unpublished", &now
	if owner := state.Sessions[binding.SessionID]; owner != nil {
		delete(owner.Tracks, binding.ID)
		invalidateReceipts(owner, binding.ID)
	}
	appendEvent(state, "", requestID, "track.unpublished", map[string]any{"track": publicTrack(binding)})
	for _, session := range state.Sessions {
		for _, subscription := range session.Subscriptions {
			if subscription.TrackID == binding.ID {
				retireSubscription(state, session, subscription, requestID, reason)
			}
		}
		invalidateReceipts(session, binding.ID)
	}
}

func retireSession(state *RoomState, session *SessionState, requestID, reason string) {
	for _, track := range session.Tracks {
		retireTrack(state, track, requestID, reason)
	}
	for _, binding := range session.Subscriptions {
		retireSubscription(state, session, binding, requestID, reason)
	}
	for id, receipt := range session.Receipts {
		receipt.Response, receipt.Failed = nil, true
		session.Receipts[id] = receipt
	}
	session.Transports = map[string]TransportBinding{}
}

func resetRuntime(state *RoomState) {
	for _, session := range state.Sessions {
		retireSession(state, session, "", "runtime_reset")
	}
	state.Sessions = map[string]*SessionState{}
}

func (adapter *Adapter) Discover(ctx context.Context, claims auth.Claims, sessionID string) ([]any, uint64, error) {
	tracks := []any{}
	var sequence uint64
	err := adapter.store.WithRoom(ctx, claims.RoomID, func(room LockedRoom) error {
		if err := room.Joined(ctx, claims, sessionID); err != nil {
			return err
		}
		scope, state, err := room.Load(ctx)
		if err != nil {
			return err
		}
		if state.Closing || (state.MediaNodeID != "" && state.MediaNodeID != adapter.nodeID) {
			return ErrUnavailable
		}
		scope.MediaNodeID, scope.Generation = state.MediaNodeID, state.Generation
		if err := adapter.cleanupInactiveSessions(ctx, room, scope, state); err != nil {
			return err
		}
		if state.Ready {
			if err := adapter.syncTracks(ctx, room, scope, state); err != nil {
				return err
			}
		}
		var bindings []TrackBinding
		for _, session := range state.Sessions {
			if session.Ended || session.Pending {
				continue
			}
			for _, binding := range session.Tracks {
				if (binding.State == "published" || binding.State == "paused" || binding.State == "resumed") && binding.RoomID == claims.RoomID && binding.Generation == state.Generation {
					bindings = append(bindings, binding)
				}
			}
		}
		sort.Slice(bindings, func(i, j int) bool { return bindings[i].ID < bindings[j].ID })
		for _, binding := range bindings {
			tracks = append(tracks, publicTrack(binding))
		}
		sequence = state.Sequence
		return nil
	})
	return tracks, sequence, err
}

type eventReader interface {
	ReadEvents(context.Context, string, uint64) ([]RuntimeEvent, uint64, error)
}

func (adapter *Adapter) Events(ctx context.Context, roomID string, after uint64) ([]RuntimeEvent, uint64, error) {
	if reader, ok := adapter.store.(eventReader); ok {
		return reader.ReadEvents(ctx, roomID, after)
	}
	var events []RuntimeEvent
	var sequence uint64
	err := adapter.store.WithRoom(ctx, roomID, func(room LockedRoom) error {
		_, state, err := room.Load(ctx)
		if err != nil {
			return err
		}
		sequence = state.Sequence
		for _, event := range state.Events {
			if event.Sequence > after {
				events = append(events, event)
			}
		}
		return nil
	})
	return events, sequence, err
}

func subscriptionRemoval(scope Scope, binding SubscriptionBinding) Command {
	return Command{Method: "DELETE", Path: "/internal/v1/rooms/" + url.PathEscape(scope.RoomID) + "/subscriptions/" + url.PathEscape(binding.MediaID), Scope: scope, Request: Operation{Operation: "subscription.remove", Body: map[string]any{"participantId": scope.MediaParticipantID}}}
}

func (adapter *Adapter) expireSubscriptions(ctx context.Context, room LockedRoom, scope Scope, state *RoomState) error {
	checkedNode := false
	for sessionID, session := range state.Sessions {
		scope.ParticipantID, scope.SessionID, scope.MediaParticipantID = session.ParticipantID, sessionID, sessionID
		for _, binding := range session.Subscriptions {
			if binding.Resumed || (!binding.CreatedAt.IsZero() && time.Since(binding.CreatedAt) < negotiationTimeout) {
				continue
			}
			if !checkedNode {
				if err := adapter.checkCleanupNode(ctx, scope); err != nil {
					return err
				}
				checkedNode = true
			}
			if _, err := adapter.media.Execute(ctx, subscriptionRemoval(scope, binding)); err != nil && !missing(err) {
				return err
			}
			retireSubscription(state, session, binding, "", "negotiation_timeout")
			if err := room.Save(ctx, state); err != nil {
				return err
			}
		}
	}
	return nil
}

func (adapter *Adapter) syncTracks(ctx context.Context, room LockedRoom, scope Scope, state *RoomState) error {
	hasTracks := false
	for _, session := range state.Sessions {
		hasTracks = hasTracks || len(session.Tracks) != 0
	}
	if !hasTracks {
		return nil
	}
	if err := adapter.checkCleanupNode(ctx, scope); err != nil {
		return err
	}
	command := Command{Method: "GET", Path: "/internal/v1/rooms/" + url.PathEscape(scope.RoomID) + "/tracks", Scope: scope, Request: Operation{Operation: "tracks.list"}}
	result, err := adapter.media.Execute(ctx, command)
	if missing(err) {
		resetRuntime(state)
		state.Ready, state.Generation = false, newID()
		return room.Save(ctx, state)
	}
	if err != nil || valueString(result, "roomId") != scope.RoomID {
		return ErrUnavailable
	}
	tracks, ok := result["tracks"].([]any)
	if !ok {
		return ErrUnavailable
	}
	alive := map[string]string{}
	for _, value := range tracks {
		track, ok := value.(map[string]any)
		if !ok || !identifier(valueString(track, "id"), 256) || !identifier(valueString(track, "participantId"), 128) {
			return ErrUnavailable
		}
		alive[valueString(track, "id")] = valueString(track, "participantId")
	}
	changed := false
	for _, session := range state.Sessions {
		for _, binding := range session.Tracks {
			if alive[binding.MediaID] != binding.SessionID {
				retireTrack(state, binding, "", "track_unpublished")
				changed = true
			}
		}
	}
	if changed {
		return room.Save(ctx, state)
	}
	return nil
}

type inactiveSessionReader interface {
	InactiveSessions(context.Context) ([]string, error)
}

func (adapter *Adapter) cleanupInactiveSessions(ctx context.Context, room LockedRoom, scope Scope, state *RoomState) error {
	reader, ok := room.(inactiveSessionReader)
	if !ok {
		return nil
	}
	ids, err := reader.InactiveSessions(ctx)
	if err != nil {
		return err
	}
	for _, sessionID := range ids {
		session := state.Sessions[sessionID]
		if session == nil {
			continue
		}
		session.Pending, session.Ended = true, true
		if err := room.Save(ctx, state); err != nil {
			return err
		}
		scope.ParticipantID, scope.SessionID, scope.MediaParticipantID = session.ParticipantID, sessionID, sessionID
		if err := adapter.cleanup(ctx, room, scope, state); err != nil {
			return err
		}
	}
	return nil
}
