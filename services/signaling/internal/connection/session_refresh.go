package connection

import (
	"context"
	"encoding/json"
	"time"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

type refreshPayload struct {
	RoomID           string `json:"roomId"`
	SessionID        string `json:"sessionId"`
	ParticipantToken string `json:"participantToken"`
}

type refreshedCredential struct {
	claims auth.Claims
	token  string
}

func (handler *Handler) tryRefresh(client *client, claims auth.Claims, joined *joinedSession, data []byte) (bool, *refreshedCredential) {
	request := requestEnvelope{}
	if json.Unmarshal(data, &request) != nil || request.Type != "session.refresh" {
		return false, nil
	}
	client.operationMu.Lock()
	defer client.operationMu.Unlock()
	if request.Version != 1 || request.ID == "" {
		client.protocolError(request.ID, "invalid_message", "The refresh request is invalid")
		return true, nil
	}
	reject := func(code, message string) {
		value := event("protocol.error", map[string]any{"code": code, "message": message, "retryable": false, "details": map[string]any{}})
		value["requestId"] = request.ID
		client.end(value, 4005, "participant credentials revoked")
	}
	if joined == nil || client.isRevoked() || !time.Now().Before(claims.ExpiresAt.Time) {
		reject("unauthorized", "The participant session cannot refresh credentials")
		return true, nil
	}
	payload := refreshPayload{}
	if json.Unmarshal(request.Payload, &payload) != nil || payload.RoomID != claims.RoomID || payload.SessionID != joined.session.ID || len(payload.ParticipantToken) == 0 || len(payload.ParticipantToken) > 8192 {
		reject("forbidden", "The refresh request does not match the active session")
		return true, nil
	}
	next, err := handler.validator.Validate(payload.ParticipantToken)
	if err != nil {
		reject("unauthorized", "The replacement participant token is invalid")
		return true, nil
	}
	sameGrant := next.RoomID == claims.RoomID && next.ParticipantID == claims.ParticipantID && next.ProjectID == claims.ProjectID && next.EnvironmentID == claims.EnvironmentID && len(next.Permissions) == len(claims.Permissions)
	for _, permission := range next.Permissions {
		sameGrant = sameGrant && hasPermission(claims.Permissions, permission)
	}
	if !handler.guestAuthorized(next) || !sameGrant || next.TokenID == claims.TokenID || !next.ExpiresAt.Time.After(claims.ExpiresAt.Time) {
		reject("forbidden", "Credential refresh must preserve identity and permissions and extend expiration")
		return true, nil
	}
	ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
	active := handler.sessionActive(ctx, claims.RoomID, claims.ParticipantID, joined.session.ID)
	cancel()
	if !active || client.isRevoked() || !time.Now().Before(claims.ExpiresAt.Time) {
		reject("forbidden", "The participant session has been revoked")
		return true, nil
	}
	client.response(request.ID, "session.refresh.accepted", map[string]any{"roomId": claims.RoomID, "sessionId": joined.session.ID, "expiresAt": next.ExpiresAt.Time.UTC()})
	return true, &refreshedCredential{claims: next, token: payload.ParticipantToken}
}
