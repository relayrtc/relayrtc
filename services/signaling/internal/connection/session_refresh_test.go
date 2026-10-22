package connection

import (
	"context"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

func renewedConnectionToken(t *testing.T, raw, tokenID string, expiry time.Time, changeIdentity bool) string {
	t.Helper()
	claims, err := auth.NewValidator(connectionTestSecret, "relayrtc-api", "relayrtc-realtime", "participant-v1").Validate(raw)
	if err != nil {
		t.Fatal(err)
	}
	claims.TokenID, claims.ID = tokenID, tokenID
	expiry = expiry.UTC().Truncate(time.Second)
	claims.ExpiresAtISO, claims.ExpiresAt = expiry.Format(time.RFC3339Nano), jwt.NewNumericDate(expiry)
	if changeIdentity {
		claims.ParticipantID, claims.Subject = "participant_other", "participant_other"
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	token.Header["kid"] = "participant-v1"
	signed, err := token.SignedString([]byte(connectionTestSecret))
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func TestSessionRefreshPreservesSessionAndExtendsConnectionExpiry(t *testing.T) {
	shutdown, cancel := context.WithCancel(context.Background())
	defer cancel()
	now := time.Now().UTC()
	handler, server := recoveryHandler(t, shutdown, recoverySessionStore(now), time.Second, nil)
	handler.pongTimeout = 10 * time.Second
	// Extend twice and prove a normal request works after the original JWT expired.
	originalExpiry := now.Add(3 * time.Second).Truncate(time.Second)
	token := connectionToken(t, originalExpiry)
	conn, _, err := dial(t, server, token, "")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	joinTestSession(t, conn, token, now)
	for _, id := range []string{"ptok_renewed_one", "ptok_renewed_two"} {
		token = renewedConnectionToken(t, token, id, originalExpiry.Add(10*time.Second), false)
		originalExpiry = originalExpiry.Add(10 * time.Second)
		if err := conn.WriteJSON(map[string]any{"v": 1, "id": id, "sentAt": time.Now().UTC(), "type": "session.refresh", "payload": map[string]any{"roomId": "room_123", "sessionId": "session_123", "participantToken": token}}); err != nil {
			t.Fatal(err)
		}
		response := map[string]any{}
		if err := conn.ReadJSON(&response); err != nil {
			t.Fatal(err)
		}
		if response["type"] != "session.refresh.accepted" {
			t.Fatalf("refresh rejected: %v", response)
		}
		payload := response["payload"].(map[string]any)
		if payload["sessionId"] != "session_123" {
			t.Fatalf("session changed: %v", payload)
		}
	}
	time.Sleep(time.Until(now.Add(3 * time.Second)))
	if err := conn.WriteJSON(map[string]any{"v": 1, "id": "after_expiry", "sentAt": time.Now().UTC(), "type": "participant.leave", "payload": map[string]any{"roomId": "room_123", "participantId": "participant_123", "sessionId": "session_123"}}); err != nil {
		t.Fatal(err)
	}
	response := map[string]any{}
	if err := conn.ReadJSON(&response); err != nil {
		t.Fatalf("connection did not survive original token expiry: %v", err)
	}
	if response["type"] != "participant.leave.accepted" {
		t.Fatalf("unexpected response: %v", response)
	}
}

func TestSessionRefreshRejectsChangedIdentity(t *testing.T) {
	shutdown, cancel := context.WithCancel(context.Background())
	defer cancel()
	now := time.Now().UTC()
	_, server := recoveryHandler(t, shutdown, recoverySessionStore(now), time.Second, nil)
	token := connectionToken(t, now.Add(time.Minute))
	conn, _, err := dial(t, server, token, "")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	joinTestSession(t, conn, token, now)
	replacement := renewedConnectionToken(t, token, "ptok_other", now.Add(2*time.Minute), true)
	if err := conn.WriteJSON(map[string]any{"v": 1, "id": "bad_refresh", "sentAt": now, "type": "session.refresh", "payload": map[string]any{"roomId": "room_123", "sessionId": "session_123", "participantToken": replacement}}); err != nil {
		t.Fatal(err)
	}
	response := map[string]any{}
	if err := conn.ReadJSON(&response); err != nil {
		t.Fatal(err)
	}
	if response["type"] != "protocol.error" {
		t.Fatalf("changed identity accepted: %v", response)
	}
}
