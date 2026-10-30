package rtc

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"time"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

type Adapter struct {
	store  RuntimeStore
	media  *MediaHTTP
	nodeID string
}

func NewAdapter(store RuntimeStore, media *MediaHTTP, nodeID string) (*Adapter, error) {
	if store == nil || media == nil || !identifier(nodeID, 128) {
		return nil, ErrInvalidRequest
	}
	return &Adapter{store: store, media: media, nodeID: nodeID}, nil
}

func (adapter *Adapter) Handle(ctx context.Context, claims auth.Claims, sessionID string, request SignalRequest) (Response, error) {
	if !identifier(claims.RoomID, 128) || !identifier(sessionID, 128) {
		return Response{}, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 9*time.Second)
	defer cancel()
	var response Response
	err := adapter.store.WithRoom(ctx, claims.RoomID, func(room LockedRoom) error {
		scope, state, err := room.Load(ctx)
		if err != nil {
			return err
		}
		if err := room.Joined(ctx, claims, sessionID); err != nil {
			return err
		}
		claims, err = effectiveClaims(ctx, room, claims)
		if err != nil {
			return err
		}
		if state.Closing || (state.MediaNodeID != "" && state.MediaNodeID != adapter.nodeID) {
			return ErrUnavailable
		}
		if state.Generation == "" {
			state.Generation = newID()
			state.MediaNodeID = adapter.nodeID
		}
		scope.ParticipantID, scope.SessionID, scope.MediaParticipantID = claims.ParticipantID, sessionID, sessionID
		scope.MediaNodeID, scope.Generation = state.MediaNodeID, state.Generation
		if state.Allocating {
			if err := adapter.releaseAllocation(ctx, room, scope, state); err != nil {
				return err
			}
			return ErrUnavailable
		}
		node, err := adapter.media.Execute(ctx, Command{Method: "GET", Path: "/ready", Scope: scope, Request: Operation{Operation: "node.ready"}})
		if err != nil || valueString(node, "nodeId") != adapter.nodeID || valueString(node, "service") != "relayrtc-media" || valueString(node, "status") != "ready" {
			return ErrUnavailable
		}
		if state.Ready {
			probe := capabilitiesCommand(scope)
			result, err := adapter.media.Execute(ctx, probe)
			if missing(err) {
				resetRuntime(state)
				state.Ready, state.Generation = false, newID()
				if err := room.Save(ctx, state); err != nil {
					return err
				}
				return ErrUnavailable
			}
			if err != nil || valueString(result, "roomId") != scope.RoomID {
				return ErrUnavailable
			}
		}
		session := state.Sessions[sessionID]
		if session == nil {
			session = newSession(claims.ParticipantID)
			state.Sessions[sessionID] = session
		}
		if session.ParticipantID != claims.ParticipantID || session.Ended {
			return ErrForbidden
		}
		if session.Pending {
			if err := adapter.cleanup(ctx, room, scope, state); err != nil {
				return err
			}
			session = state.Sessions[sessionID]
		}
		if err := adapter.expireSubscriptions(ctx, room, scope, state); err != nil {
			return err
		}
		if err := adapter.revokePublications(ctx, room, scope, state); err != nil {
			return err
		}
		fingerprint, err := RequestFingerprint(scope, request)
		if err != nil {
			return err
		}
		if receipt, exists := session.Receipts[request.RequestID]; exists {
			if receipt.Fingerprint != fingerprint {
				return ErrRequestConflict
			}
			if receipt.Failed || receipt.Response == nil {
				return ErrUnavailable
			}
			response = *receipt.Response
			return nil
		}
		resources := sessionResources(state, session, request)
		command, err := Plan(request, claims, scope, resources)
		if err != nil {
			return err
		}
		if command.Request.Operation == "subscription.already-removed" {
			response = Response{Type: command.ResponseType, Payload: map[string]any{
				"roomId": scope.RoomID, "sessionId": scope.SessionID,
				"subscriptionId": command.Metadata["subscriptionId"],
			}}
			return nil
		}
		if command.Request.Operation == "stats.report" {
			// Stats do not allocate resources or consume the lifetime negotiation receipt budget.
			if _, err := adapter.media.Execute(ctx, command); err != nil {
				return err
			}
			response = Response{Type: command.ResponseType, Payload: map[string]any{"roomId": scope.RoomID, "sessionId": scope.SessionID}}
			return nil
		}
		if command.Request.Operation == "subscription.quality" {
			if _, err := adapter.media.Execute(ctx, command); err != nil {
				return err
			}
			response = Response{Type: command.ResponseType, Payload: map[string]any{"roomId": scope.RoomID, "sessionId": scope.SessionID, "subscriptionId": command.Metadata["subscriptionId"], "quality": command.Request.Body["quality"]}}
			return nil
		}
		if len(session.Receipts) >= 4096 || (command.Request.Operation == "transport.create" && len(session.Transports) >= 128) || (command.Request.Operation == "track.publish" && len(session.Tracks) >= 256) || (command.Request.Operation == "track.subscribe" && len(session.Subscriptions) >= 512) {
			return ErrUnavailable
		}
		if !state.Ready {
			state.Allocating = true
			if err := room.Save(ctx, state); err != nil {
				return err
			}
			allocation, _ := LifecycleCommand("room.create", scope, request.RequestID)
			result, err := adapter.media.Execute(ctx, allocation)
			if err != nil || valueString(result, "roomId") != scope.RoomID {
				cleanup, cancelCleanup := context.WithTimeout(context.Background(), 4*time.Second)
				defer cancelCleanup()
				_ = adapter.releaseAllocation(cleanup, room, scope, state)
				return ErrUnavailable
			}
			state.Allocating = false
			state.Ready = true
			if err := room.Save(ctx, state); err != nil {
				return err
			}
		}
		if err := room.Assign(ctx, sessionID, scope.MediaNodeID); err != nil {
			return err
		}
		mutation := command.Method != "GET"
		if mutation {
			session.Pending = true
			session.Receipts[request.RequestID] = Receipt{Fingerprint: fingerprint, Failed: true}
			if err := room.Save(ctx, state); err != nil {
				return err
			}
		}
		result, callError := adapter.media.Execute(ctx, command)
		if callError == nil {
			response, callError = TranslateResponse(command, result, session, resources)
			if callError != nil && mutation {
				callError = &mediaFailure{cause: ErrUnavailable, ambiguous: true}
			}
		}
		if callError == nil {
			callError = room.Joined(ctx, claims, sessionID)
			if callError != nil && mutation {
				callError = &mediaFailure{cause: callError, ambiguous: true}
			}
		}
		if callError != nil {
			if missing(callError) {
				probe := capabilitiesCommand(scope)
				_, probeError := adapter.media.Execute(ctx, probe)
				if missing(probeError) {
					state.Ready = false
					state.Generation = newID()
					resetRuntime(state)
					if err := room.Save(ctx, state); err != nil {
						return err
					}
					return ErrUnavailable
				}
			}
			if mutation && (ambiguous(callError) || errors.Is(callError, ErrForbidden) || ctx.Err() != nil) {
				cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 4*time.Second)
				defer cancelCleanup()
				if err := adapter.cleanup(cleanupContext, room, scope, state); err != nil {
					return ErrUnavailable
				}
			} else if mutation {
				session.Pending = false
				if err := room.Save(ctx, state); err != nil {
					return err
				}
			}
			return callError
		}
		session.Pending = false
		switch command.Request.Operation {
		case "track.publish":
			appendEvent(state, "", request.RequestID, "track.published", map[string]any{"track": response.Payload["track"]})
		case "track.pause", "track.resume":
			kind := "track.paused"
			if command.Request.Operation == "track.resume" {
				kind = "track.resumed"
			}
			appendEvent(state, "", request.RequestID, kind, map[string]any{"track": response.Payload["track"]})
		case "track.remove":
			retireTrack(state, *resources.Track, request.RequestID, "track_unpublished")
		case "subscription.remove":
			retireSubscription(state, session, *resources.Subscription, request.RequestID, "cancelled")
		}
		session.Receipts[request.RequestID] = Receipt{Fingerprint: fingerprint, Response: &response}
		if err := room.Save(ctx, state); err != nil {
			return err
		}
		return nil
	})
	return response, err
}

func capabilitiesCommand(scope Scope) Command {
	return Command{Method: "GET", Path: "/internal/v1/rooms/" + url.PathEscape(scope.RoomID) + "/capabilities", Scope: scope, Request: Operation{Operation: "capabilities.get"}}
}

func sessionResources(state *RoomState, session *SessionState, request SignalRequest) Resources {
	var payload map[string]any
	_ = json.Unmarshal(request.Payload, &payload)
	resources := Resources{}
	if binding, ok := session.Transports[valueString(payload, "transportId")]; ok {
		resources.Transport = &binding
	}
	if binding, ok := session.Subscriptions[valueString(payload, "subscriptionId")]; ok {
		resources.Subscription = &binding
	}
	for _, owner := range state.Sessions {
		if owner.Ended || owner.Pending {
			continue
		}
		if binding, ok := owner.Tracks[valueString(payload, "trackId")]; ok {
			resources.Track = &binding
			break
		}
	}
	return resources
}

func (adapter *Adapter) cleanup(ctx context.Context, room LockedRoom, scope Scope, state *RoomState) error {
	if session := state.Sessions[scope.SessionID]; session != nil {
		reason := "runtime_reset"
		if session.Ended {
			reason = "owner_left"
		}
		retireSession(state, session, "", reason)
		if err := room.Save(ctx, state); err != nil {
			return err
		}
	}
	if err := adapter.checkCleanupNode(ctx, scope); err != nil {
		return err
	}
	command, err := LifecycleCommand("participant.remove", scope, "cleanup_"+newID())
	if err != nil {
		return err
	}
	if _, err := adapter.media.Execute(ctx, command); err != nil && !missing(err) {
		return ErrUnavailable
	}
	old := state.Sessions[scope.SessionID]
	if old != nil && old.Ended {
		delete(state.Sessions, scope.SessionID)
		return room.Save(ctx, state)
	}
	fresh := newSession(scope.ParticipantID)
	if old != nil {
		for id, receipt := range old.Receipts {
			receipt.Response = nil
			receipt.Failed = true
			fresh.Receipts[id] = receipt
		}
	}
	state.Sessions[scope.SessionID] = fresh
	return room.Save(ctx, state)
}

func (adapter *Adapter) RemoveSession(ctx context.Context, roomID, participantID, sessionID string) error {
	return adapter.store.WithRoom(ctx, roomID, func(room LockedRoom) error {
		scope, state, err := room.Load(ctx)
		if err != nil {
			return err
		}
		session := state.Sessions[sessionID]
		if session == nil {
			return nil
		}
		if session.ParticipantID != participantID {
			return ErrForbidden
		}
		if state.MediaNodeID != adapter.nodeID {
			return ErrUnavailable
		}
		scope.ParticipantID, scope.SessionID, scope.MediaParticipantID = participantID, sessionID, sessionID
		scope.MediaNodeID, scope.Generation = state.MediaNodeID, state.Generation
		session.Pending = true
		session.Ended = true
		if err := room.Save(ctx, state); err != nil {
			return err
		}
		if err := adapter.cleanup(ctx, room, scope, state); err != nil {
			return err
		}
		delete(state.Sessions, sessionID)
		return room.Save(ctx, state)
	})
}

func (adapter *Adapter) CloseRoom(ctx context.Context, roomID string) error {
	return adapter.store.WithRoom(ctx, roomID, func(room LockedRoom) error {
		scope, state, err := room.Load(ctx)
		if errors.Is(err, ErrForbidden) {
			return nil
		}
		if err != nil {
			return err
		}
		if state.Generation == "" && len(state.Sessions) == 0 && !state.Allocating && !state.Ready {
			return nil
		}
		state.Closing = true
		if err := room.Save(ctx, state); err != nil {
			return err
		}
		if state.Generation == "" {
			return nil
		}
		if state.MediaNodeID != adapter.nodeID {
			return ErrUnavailable
		}
		scope.MediaNodeID, scope.Generation = state.MediaNodeID, state.Generation
		if err := adapter.checkCleanupNode(ctx, scope); err != nil {
			return err
		}
		command, _ := LifecycleCommand("room.close", scope, "close_"+newID())
		if _, err := adapter.media.Execute(ctx, command); err != nil && !missing(err) {
			return err
		}
		state.Ready = false
		state.Allocating = false
		state.Generation = ""
		resetRuntime(state)
		return room.Save(ctx, state)
	})
}

func (adapter *Adapter) checkCleanupNode(ctx context.Context, scope Scope) error {
	node, err := adapter.media.Execute(ctx, Command{Method: "GET", Path: "/health", Scope: scope, Request: Operation{Operation: "node.health"}})
	if err != nil || valueString(node, "nodeId") != scope.MediaNodeID || valueString(node, "service") != "relayrtc-media" || valueString(node, "status") != "ok" {
		return ErrUnavailable
	}
	return nil
}

func (adapter *Adapter) releaseAllocation(ctx context.Context, room LockedRoom, scope Scope, state *RoomState) error {
	if err := adapter.checkCleanupNode(ctx, scope); err != nil {
		return err
	}
	command, err := LifecycleCommand("room.close", scope, "release_"+newID())
	if err != nil {
		return err
	}
	if _, err := adapter.media.Execute(ctx, command); err != nil && !missing(err) {
		return ErrUnavailable
	}
	state.Ready, state.Allocating, state.Generation, state.MediaNodeID = false, false, "", ""
	resetRuntime(state)
	return room.Save(ctx, state)
}
