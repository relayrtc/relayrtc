package rtc

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strings"
	"unicode"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

type SignalRequest struct {
	RequestID string          `json:"requestId"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

func identifier(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && !strings.ContainsFunc(value, unicode.IsSpace)
}

func permitted(permissions []string, permission string) bool {
	for _, value := range permissions {
		if value == permission {
			return true
		}
	}
	return false
}

func valueString(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return value
}

func object(payload map[string]any, key string) (map[string]any, bool) {
	value, ok := payload[key].(map[string]any)
	return value, ok && value != nil
}

func validDTLS(value map[string]any) bool {
	if len(value) != 2 {
		return false
	}
	role := valueString(value, "role")
	if role != "auto" && role != "client" && role != "server" {
		return false
	}
	fingerprints, ok := value["fingerprints"].([]any)
	if !ok || len(fingerprints) == 0 {
		return false
	}
	for _, entry := range fingerprints {
		fingerprint, ok := entry.(map[string]any)
		if !ok || len(fingerprint) != 2 {
			return false
		}
		algorithm := valueString(fingerprint, "algorithm")
		switch algorithm {
		case "sha-1", "sha-224", "sha-256", "sha-384", "sha-512":
		default:
			return false
		}
		if value := valueString(fingerprint, "value"); value == "" || len(value) > 512 {
			return false
		}
	}
	return true
}

func Plan(request SignalRequest, claims auth.Claims, scope Scope, resources Resources) (Command, error) {
	if claims.ProjectID != scope.ProjectID || claims.EnvironmentID != scope.EnvironmentID || claims.RoomID != scope.RoomID || claims.ParticipantID != scope.ParticipantID || !permitted(claims.Permissions, "room:join") {
		return Command{}, ErrForbidden
	}
	for _, value := range []string{scope.ProjectID, scope.EnvironmentID, scope.RoomID, scope.ParticipantID, scope.SessionID, scope.MediaNodeID, scope.MediaParticipantID, scope.Generation} {
		if !identifier(value, 128) {
			return Command{}, ErrInvalidRequest
		}
	}
	if scope.MediaParticipantID != scope.SessionID || !identifier(request.RequestID, 128) {
		return Command{}, ErrInvalidRequest
	}
	var payload map[string]any
	if len(request.Payload) > 131072 || json.Unmarshal(request.Payload, &payload) != nil || payload == nil {
		return Command{}, ErrInvalidRequest
	}
	if valueString(payload, "roomId") != scope.RoomID || valueString(payload, "sessionId") != scope.SessionID {
		return Command{}, ErrForbidden
	}
	allowed := map[string]bool{"roomId": true, "sessionId": true}
	fields := map[string][]string{
		"rtc.capabilities.get":     {},
		"rtc.transport.create":     {"direction"},
		"rtc.transport.connect":    {"transportId", "dtlsParameters"},
		"rtc.ice.restart":          {"transportId"},
		"rtc.track.publish":        {"transportId", "trackType", "rtpParameters", "metadata"},
		"rtc.track.subscribe":      {"transportId", "trackId", "rtpCapabilities", "quality"},
		"rtc.subscription.quality": {"subscriptionId", "quality"},
		"rtc.track.control":        {"trackId", "action"},
		"rtc.subscription.resume":  {"subscriptionId"},
		"rtc.subscription.close":   {"subscriptionId"},
		"rtc.stats.report":         {"transportId", "stats"},
	}
	keys, supported := fields[request.Type]
	if !supported {
		return Command{}, ErrUnsupported
	}
	for _, key := range keys {
		allowed[key] = true
	}
	for key := range payload {
		if !allowed[key] {
			return Command{}, ErrInvalidRequest
		}
	}
	command := Command{RequestID: request.RequestID, Scope: scope, Metadata: map[string]any{}}
	base := "/internal/v1/rooms/" + url.PathEscape(scope.RoomID)
	command.Path = base
	command.Request.Body = map[string]any{"participantId": scope.MediaParticipantID}
	if request.Type == "rtc.capabilities.get" {
		command.Method, command.Path, command.ResponseType = "GET", base+"/capabilities", "rtc.capabilities"
		command.Request = Operation{Operation: "capabilities.get"}
		return command, nil
	}
	if request.Type == "rtc.transport.create" {
		direction := valueString(payload, "direction")
		if direction != "send" && direction != "receive" {
			return Command{}, ErrInvalidRequest
		}
		command.Method, command.Path, command.ResponseType = "POST", base+"/transports", "rtc.transport.created"
		command.Request.Operation = "transport.create"
		command.Request.Body["direction"] = direction
		return command, nil
	}
	if request.Type == "rtc.track.control" {
		track := resources.Track
		if track == nil || track.ID != valueString(payload, "trackId") || track.RoomID != scope.RoomID || track.SessionID != scope.SessionID || track.MediaNodeID != scope.MediaNodeID || track.Generation != scope.Generation || !identifier(track.MediaID, 256) {
			return Command{}, ErrForbidden
		}
		switch valueString(payload, "action") {
		case "pause", "resume":
			action := valueString(payload, "action")
			if action == "resume" && !permitted(claims.Permissions, publicationPermission(track.Type)) {
				return Command{}, ErrForbidden
			}
			command.Method, command.Path, command.ResponseType = "PATCH", base+"/participants/"+url.PathEscape(scope.MediaParticipantID)+"/tracks/"+url.PathEscape(track.MediaID)+"/"+action, "rtc.track.control.accepted"
			command.Request = Operation{Operation: "track." + action}
			return command, nil
		case "unpublish":
		default:
			return Command{}, ErrInvalidRequest
		}
		command.Method, command.Path, command.ResponseType = "DELETE", base+"/participants/"+url.PathEscape(scope.MediaParticipantID)+"/tracks/"+url.PathEscape(track.MediaID), "rtc.track.control.accepted"
		command.Request = Operation{Operation: "track.remove"}
		return command, nil
	}
	if request.Type == "rtc.subscription.resume" || request.Type == "rtc.subscription.close" || request.Type == "rtc.subscription.quality" {
		subscription := resources.Subscription
		if subscription == nil && request.Type == "rtc.subscription.close" {
			subscriptionID := valueString(payload, "subscriptionId")
			if !identifier(subscriptionID, 128) {
				return Command{}, ErrInvalidRequest
			}
			// Closing an already retired subscription is safe within this session.
			command.ResponseType = "rtc.subscription.close.accepted"
			command.Request.Operation = "subscription.already-removed"
			command.Metadata["subscriptionId"] = subscriptionID
			return command, nil
		}
		if subscription == nil || subscription.ID != valueString(payload, "subscriptionId") || subscription.RoomID != scope.RoomID || subscription.SessionID != scope.SessionID || subscription.MediaNodeID != scope.MediaNodeID || subscription.Generation != scope.Generation || !identifier(subscription.MediaID, 256) {
			return Command{}, ErrForbidden
		}
		if request.Type == "rtc.subscription.quality" {
			quality := valueString(payload, "quality")
			if !validVideoQuality(quality) {
				return Command{}, ErrInvalidRequest
			}
			command.Method, command.Path, command.ResponseType = "PATCH", base+"/subscriptions/"+url.PathEscape(subscription.MediaID)+"/quality", "rtc.subscription.quality.accepted"
			command.Request.Operation = "subscription.quality"
			command.Request.Body["quality"] = quality
			command.Metadata["subscriptionId"] = subscription.ID
			return command, nil
		}
		command.Method, command.Path, command.ResponseType = "PATCH", base+"/subscriptions/"+url.PathEscape(subscription.MediaID)+"/resume", "rtc.subscription.resumed"
		command.Request.Operation = "subscription.resume"
		if request.Type == "rtc.subscription.close" {
			command.Method, command.Path, command.ResponseType = "DELETE", base+"/subscriptions/"+url.PathEscape(subscription.MediaID), "rtc.subscription.close.accepted"
			command.Request.Operation = "subscription.remove"
		}
		return command, nil
	}
	transport := resources.Transport
	if transport == nil || transport.ID != valueString(payload, "transportId") || transport.RoomID != scope.RoomID || transport.SessionID != scope.SessionID || transport.MediaNodeID != scope.MediaNodeID || transport.Generation != scope.Generation || !identifier(transport.MediaID, 256) {
		return Command{}, ErrForbidden
	}
	switch request.Type {
	case "rtc.stats.report":
		if transport.Direction != "receive" {
			return Command{}, ErrForbidden
		}
		stats, ok := object(payload, "stats")
		if !ok || !validSubscriberStats(stats) {
			return Command{}, ErrInvalidRequest
		}
		command.Method, command.Path, command.ResponseType = "POST", base+"/stats", "rtc.stats.accepted"
		command.Request.Operation = "stats.report"
		command.Request.Body["stats"], command.Request.Body["publicParticipantId"] = stats, scope.ParticipantID
		command.Request.Body["transportId"] = transport.MediaID
	case "rtc.transport.connect":
		dtls, ok := object(payload, "dtlsParameters")
		if !ok || !validDTLS(dtls) {
			return Command{}, ErrInvalidRequest
		}
		command.Method, command.Path, command.ResponseType = "PATCH", base+"/transports/"+url.PathEscape(transport.MediaID), "rtc.transport.connected"
		command.Request.Operation = "transport.connect"
		command.Request.Body["dtlsParameters"] = dtls
	case "rtc.ice.restart":
		command.Method, command.Path, command.ResponseType = "POST", base+"/transports/"+url.PathEscape(transport.MediaID)+"/restart-ice", "rtc.ice.restarted"
		command.Request.Operation = "ice.restart"
	case "rtc.track.publish":
		if transport.Direction != "send" {
			return Command{}, ErrForbidden
		}
		trackType := valueString(payload, "trackType")
		kind, permission := "", ""
		switch trackType {
		case "audio":
			kind, permission = "audio", "audio:publish"
		case "camera_video":
			kind, permission = "video", "video:publish"
		case "screen_audio":
			kind, permission = "audio", "screen:publish"
		case "screen_video":
			kind, permission = "video", "screen:publish"
		case "data":
			return Command{}, ErrUnsupported
		default:
			return Command{}, ErrInvalidRequest
		}
		if !permitted(claims.Permissions, permission) {
			return Command{}, ErrForbidden
		}
		rtp, ok := object(payload, "rtpParameters")
		if !ok {
			return Command{}, ErrInvalidRequest
		}
		if _, exists := payload["metadata"]; exists {
			metadata, ok := object(payload, "metadata")
			if !ok {
				return Command{}, ErrInvalidRequest
			}
			command.Metadata = metadata
		}
		command.Method, command.Path, command.ResponseType = "POST", base+"/tracks", "rtc.track.publish.accepted"
		command.Request.Operation = "track.publish"
		command.Request.Body["kind"], command.Request.Body["trackType"], command.Request.Body["rtpParameters"], command.Request.Body["transportId"] = kind, trackType, rtp, transport.MediaID
		if height, ok := command.Metadata["sourceHeight"].(float64); ok && height > 0 && height <= 16384 {
			command.Request.Body["sourceHeight"] = height
		}
	case "rtc.track.subscribe":
		if transport.Direction != "receive" {
			return Command{}, ErrForbidden
		}
		track := resources.Track
		if track == nil || track.ID != valueString(payload, "trackId") || track.RoomID != scope.RoomID || track.MediaNodeID != scope.MediaNodeID || track.Generation != scope.Generation || !identifier(track.MediaID, 256) {
			return Command{}, ErrForbidden
		}
		rtp, ok := object(payload, "rtpCapabilities")
		if !ok {
			return Command{}, ErrInvalidRequest
		}
		command.Method, command.Path, command.ResponseType = "POST", base+"/subscriptions", "rtc.track.subscribe.accepted"
		command.Request.Operation = "track.subscribe"
		command.Request.Body["trackId"], command.Request.Body["transportId"], command.Request.Body["rtpCapabilities"] = track.MediaID, transport.MediaID, rtp
		if quality, exists := payload["quality"]; exists {
			value, ok := quality.(string)
			if !ok || !validVideoQuality(value) {
				return Command{}, ErrInvalidRequest
			}
			command.Request.Body["quality"] = value
		}
	}
	return command, nil
}

func validVideoQuality(quality string) bool {
	switch quality {
	case "auto", "1080p", "720p", "360p", "audio-only":
		return true
	default:
		return false
	}
}

func validSubscriberStats(stats map[string]any) bool {
	required := map[string]bool{"availableIncomingBitrate": true, "jitter": true, "roundTripTime": true, "packetsLost": true, "packetsReceived": true, "timestamp": true}
	for key, raw := range stats {
		switch key {
		case "stale":
			if _, ok := raw.(bool); !ok {
				return false
			}
			continue
		case "availableIncomingBitrate", "incomingBitrate", "jitter", "roundTripTime", "packetLossRatio":
			if raw == nil {
				delete(required, key)
				continue
			}
		case "packetsLost", "packetsReceived", "timestamp":
		default:
			return false
		}
		value, ok := raw.(float64)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return false
		}
		if key == "packetLossRatio" && value > 1 {
			return false
		}
		if (key == "packetsLost" || key == "packetsReceived") && (math.Trunc(value) != value || value > 9007199254740991) {
			return false
		}
		if key == "timestamp" && value <= 0 {
			return false
		}
		delete(required, key)
	}
	return len(required) == 0
}

func LifecycleCommand(operation string, scope Scope, requestID string) (Command, error) {
	for _, value := range []string{scope.ProjectID, scope.EnvironmentID, scope.RoomID, scope.MediaNodeID, scope.Generation} {
		if !identifier(value, 128) {
			return Command{}, ErrInvalidRequest
		}
	}
	if !identifier(requestID, 256) || (operation == "participant.remove" && (!identifier(scope.ParticipantID, 128) || !identifier(scope.SessionID, 128) || scope.MediaParticipantID != scope.SessionID)) {
		return Command{}, ErrInvalidRequest
	}
	command := Command{RequestID: requestID, Scope: scope, Path: "/internal/v1/rooms/" + url.PathEscape(scope.RoomID), Request: Operation{Operation: operation}, Metadata: map[string]any{}}
	switch operation {
	case "room.create":
		command.Method = "POST"
	case "room.close":
		command.Method = "DELETE"
	case "participant.remove":
		command.Method, command.Path = "DELETE", fmt.Sprintf("%s/participants/%s", command.Path, url.PathEscape(scope.MediaParticipantID))
	default:
		return Command{}, ErrUnsupported
	}
	return command, nil
}
