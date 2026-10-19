package rtc

import "time"

func validICE(value map[string]any) bool {
	if value == nil || len(value) != 3 {
		return false
	}
	for _, key := range []string{"usernameFragment", "password"} {
		value := valueString(value, key)
		if value == "" || len(value) > 256 {
			return false
		}
	}
	_, ok := value["iceLite"].(bool)
	return ok
}

func validCandidates(values any) bool {
	entries, ok := values.([]any)
	if !ok || len(entries) == 0 || len(entries) > 64 {
		return false
	}
	for _, entry := range entries {
		candidate, ok := entry.(map[string]any)
		if !ok || len(candidate) < 6 || len(candidate) > 7 {
			return false
		}
		for key := range candidate {
			switch key {
			case "foundation", "priority", "ip", "protocol", "port", "type", "tcpType":
			default:
				return false
			}
		}
		for _, key := range []string{"foundation", "ip"} {
			value := valueString(candidate, key)
			if value == "" || len(value) > 256 {
				return false
			}
		}
		priority, priorityOK := candidate["priority"].(float64)
		port, portOK := candidate["port"].(float64)
		if !priorityOK || priority < 0 || priority > 4_294_967_295 || priority != float64(uint32(priority)) || !portOK || port < 1 || port > 65535 || port != float64(uint16(port)) {
			return false
		}
		if protocol := valueString(candidate, "protocol"); protocol != "udp" && protocol != "tcp" {
			return false
		}
		switch valueString(candidate, "type") {
		case "host", "srflx", "prflx", "relay":
		default:
			return false
		}
		if tcp, exists := candidate["tcpType"]; exists && tcp != "active" && tcp != "passive" && tcp != "so" {
			return false
		}
	}
	return true
}

func publicTrack(track TrackBinding) map[string]any {
	return map[string]any{
		"id": track.ID, "roomId": track.RoomID, "participantId": track.ParticipantID,
		"sessionId": track.SessionID, "type": track.Type, "state": track.State,
		"priority": track.Priority, "metadata": track.Metadata,
		"publishedAt": track.PublishedAt, "unpublishedAt": track.UnpublishedAt,
	}
}

func publicCandidates(value any) ([]any, bool) {
	entries, ok := value.([]any)
	if !ok {
		return nil, false
	}
	result := make([]any, 0, len(entries))
	for _, entry := range entries {
		candidate, ok := entry.(map[string]any)
		if !ok {
			return nil, false
		}
		projected := map[string]any{}
		for key, value := range candidate {
			if key == "address" {
				if value != candidate["ip"] {
					return nil, false
				}
				continue
			}
			projected[key] = value
		}
		result = append(result, projected)
	}
	return result, validCandidates(result)
}

func TranslateResponse(command Command, result map[string]any, state *SessionState, resources Resources) (Response, error) {
	scope := command.Scope
	payload := map[string]any{"roomId": scope.RoomID, "sessionId": scope.SessionID}
	response := Response{Type: command.ResponseType, Payload: payload}
	switch command.Request.Operation {
	case "capabilities.get":
		capabilities, ok := object(result, "routerCapabilities")
		if !ok || valueString(result, "roomId") != scope.RoomID {
			return Response{}, ErrUnavailable
		}
		response.Payload = map[string]any{"routerCapabilities": capabilities}
	case "transport.create":
		ice, iceOK := object(result, "iceParameters")
		dtls, dtlsOK := object(result, "dtlsParameters")
		candidates, candidatesOK := publicCandidates(result["iceCandidates"])
		id := valueString(result, "id")
		direction := valueString(command.Request.Body, "direction")
		if valueString(result, "roomId") != scope.RoomID || !identifier(id, 256) || valueString(result, "direction") != direction || !iceOK || !validICE(ice) || !dtlsOK || !validDTLS(dtls) || !candidatesOK {
			return Response{}, ErrUnavailable
		}
		publicID := "transport_" + newID()
		state.Transports[publicID] = TransportBinding{ID: publicID, MediaID: id, RoomID: scope.RoomID, SessionID: scope.SessionID, MediaNodeID: scope.MediaNodeID, Generation: scope.Generation, Direction: direction}
		payload["transportId"], payload["direction"] = publicID, direction
		payload["iceParameters"], payload["iceCandidates"], payload["dtlsParameters"] = ice, candidates, dtls
	case "transport.connect":
		payload["transportId"] = resources.Transport.ID
	case "ice.restart":
		ice, ok := object(result, "iceParameters")
		if !ok || !validICE(ice) {
			return Response{}, ErrUnavailable
		}
		payload["transportId"], payload["iceParameters"] = resources.Transport.ID, ice
	case "track.publish":
		track, ok := object(result, "track")
		id := valueString(track, "id")
		priority := valueString(track, "priority")
		if !ok || valueString(result, "roomId") != scope.RoomID || !identifier(id, 256) || valueString(track, "participantId") != scope.MediaParticipantID || valueString(track, "trackType") != valueString(command.Request.Body, "trackType") || valueString(track, "kind") != valueString(command.Request.Body, "kind") || (priority != "high" && priority != "normal" && priority != "low") {
			return Response{}, ErrUnavailable
		}
		binding := TrackBinding{ID: "track_" + newID(), MediaID: id, RoomID: scope.RoomID, SessionID: scope.SessionID, MediaNodeID: scope.MediaNodeID, Generation: scope.Generation, ParticipantID: scope.ParticipantID, Type: valueString(track, "trackType"), State: "published", Priority: priority, Metadata: command.Metadata, PublishedAt: time.Now().UTC()}
		state.Tracks[binding.ID] = binding
		payload["track"] = publicTrack(binding)
	case "track.pause", "track.resume":
		track := *resources.Track
		track.State = "paused"
		if command.Request.Operation == "track.resume" {
			track.State = "resumed"
		}
		state.Tracks[track.ID] = track
		payload["track"] = publicTrack(track)
	case "track.remove":
		track := *resources.Track
		now := time.Now().UTC()
		track.State, track.UnpublishedAt = "unpublished", &now
		delete(state.Tracks, track.ID)
		payload["track"] = publicTrack(track)
	case "track.subscribe":
		subscription, ok := object(result, "subscription")
		id := valueString(subscription, "id")
		rtp, rtpOK := object(subscription, "rtpParameters")
		if !ok || valueString(result, "roomId") != scope.RoomID || !identifier(id, 256) || valueString(subscription, "producerId") != resources.Track.MediaID || valueString(subscription, "trackId") != resources.Track.MediaID || valueString(subscription, "trackType") != resources.Track.Type || !rtpOK {
			return Response{}, ErrUnavailable
		}
		publicID := "subscription_" + newID()
		state.Subscriptions[publicID] = SubscriptionBinding{ID: publicID, MediaID: id, RoomID: scope.RoomID, SessionID: scope.SessionID, MediaNodeID: scope.MediaNodeID, Generation: scope.Generation, TrackID: resources.Track.ID, TransportID: resources.Transport.ID, CreatedAt: time.Now().UTC()}
		payload["subscriptionId"], payload["trackId"], payload["trackType"], payload["rtpParameters"] = publicID, resources.Track.ID, resources.Track.Type, rtp
	case "subscription.resume":
		binding := *resources.Subscription
		binding.Resumed = true
		state.Subscriptions[binding.ID] = binding
		payload["subscriptionId"] = binding.ID
	case "subscription.remove":
		delete(state.Subscriptions, resources.Subscription.ID)
		payload["subscriptionId"] = resources.Subscription.ID
	default:
		return Response{}, ErrUnsupported
	}
	return response, nil
}
