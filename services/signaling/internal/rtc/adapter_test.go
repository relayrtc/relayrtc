package rtc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

const adapterSecret = "test-rtc-control-secret-with-32-characters"

func cloneState(state *RoomState) (*RoomState, error) {
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	var result RoomState
	err = json.Unmarshal(encoded, &result)
	return &result, err
}

type memoryRoom struct {
	mu     sync.Mutex
	state  *RoomState
	joined map[string]string
}

func newMemoryRoom() *memoryRoom {
	return &memoryRoom{state: &RoomState{Sessions: map[string]*SessionState{}}, joined: map[string]string{"session_a": "participant_a", "session_b": "participant_b"}}
}

func (room *memoryRoom) WithRoom(_ context.Context, roomID string, action func(LockedRoom) error) error {
	room.mu.Lock()
	defer room.mu.Unlock()
	if roomID != "room_a" {
		return ErrForbidden
	}
	return action(room)
}

func (room *memoryRoom) Load(_ context.Context) (Scope, *RoomState, error) {
	state, err := cloneState(room.state)
	return Scope{ProjectID: "project_a", EnvironmentID: "env_a", RoomID: "room_a"}, state, err
}

func (room *memoryRoom) Joined(_ context.Context, claims auth.Claims, sessionID string) error {
	if room.joined[sessionID] != claims.ParticipantID || claims.ProjectID != "project_a" || claims.EnvironmentID != "env_a" || claims.RoomID != "room_a" {
		return ErrForbidden
	}
	return nil
}

func (room *memoryRoom) Save(_ context.Context, state *RoomState) error {
	var err error
	room.state, err = cloneState(state)
	return err
}

func (room *memoryRoom) Assign(_ context.Context, _, _ string) error { return nil }

func adapterClaims(participant string) auth.Claims {
	return auth.Claims{RoomID: "room_a", ProjectID: "project_a", EnvironmentID: "env_a", ParticipantID: participant, Permissions: []string{"room:join", "audio:publish", "video:publish", "screen:publish"}}
}

func adapterRequest(id, message, session string, extra map[string]any) SignalRequest {
	payload := map[string]any{"roomId": "room_a", "sessionId": session}
	for key, value := range extra {
		payload[key] = value
	}
	encoded, _ := json.Marshal(payload)
	return SignalRequest{RequestID: id, Type: message, Payload: encoded}
}

func transportResult() map[string]any {
	return map[string]any{
		"roomId": "room_a", "id": "media_transport", "direction": "send",
		"iceParameters":  map[string]any{"usernameFragment": "ufrag", "password": "password", "iceLite": true},
		"iceCandidates":  []any{map[string]any{"foundation": "foundation", "priority": 100, "ip": "127.0.0.1", "protocol": "udp", "port": 40000, "type": "host"}},
		"dtlsParameters": map[string]any{"role": "auto", "fingerprints": []any{map[string]any{"algorithm": "sha-256", "value": "AA:BB"}}},
	}
}

type testMedia struct {
	mu               sync.Mutex
	calls            map[string]int
	room             bool
	status           int
	allocationStatus int
	malformed        bool
	delay            time.Duration
	nodeID           string
	owners           []string
}

func (media *testMedia) serve(t *testing.T, response http.ResponseWriter, request *http.Request) {
	t.Helper()
	media.mu.Lock()
	defer media.mu.Unlock()
	if request.URL.Path == "/ready" || request.URL.Path == "/health" {
		status := "ready"
		if request.URL.Path == "/health" {
			status = "ok"
		}
		_ = json.NewEncoder(response).Encode(map[string]any{"nodeId": media.nodeID, "service": "relayrtc-media", "status": status})
		return
	}
	token, err := jwt.Parse(strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "), func(_ *jwt.Token) (any, error) { return []byte(adapterSecret), nil }, jwt.WithValidMethods([]string{"HS256"}), jwt.WithAudience("relayrtc-media-control"), jwt.WithIssuer("relayrtc-signaling"), jwt.WithExpirationRequired())
	if err != nil {
		t.Errorf("unsigned control request: %v", err)
		response.WriteHeader(401)
		return
	}
	claims := token.Claims.(jwt.MapClaims)
	if token.Header["typ"] != "relayrtc-media-control+jwt" || claims["path"] != request.URL.EscapedPath() || claims["method"] != request.Method {
		t.Error("control token not bound to request")
	}
	authority := claims["authority"].(map[string]any)
	if authority["roomId"] != "room_a" {
		t.Error("wrong room grant")
	}
	var body map[string]any
	if request.Body != nil {
		_ = json.NewDecoder(request.Body).Decode(&body)
	}
	if participant, exists := body["participantId"]; exists && (participant != authority["participantId"] || participant != authority["sessionId"]) {
		t.Error("participant alias was not session-scoped")
	}
	key := request.Method + " " + request.URL.Path
	media.calls[key]++
	base := "/internal/v1/rooms/room_a"
	if request.URL.Path == base {
		if request.Method == "DELETE" {
			media.room = false
			response.WriteHeader(204)
			return
		}
		if media.allocationStatus != 0 {
			response.WriteHeader(media.allocationStatus)
			return
		}
		media.room = true
		response.WriteHeader(201)
		_ = json.NewEncoder(response).Encode(map[string]any{"roomId": "room_a"})
		return
	}
	if !media.room {
		response.WriteHeader(404)
		return
	}
	if request.Method == "DELETE" && strings.Contains(request.URL.Path, "/participants/") {
		alias := strings.TrimPrefix(request.URL.Path, base+"/participants/")
		if !strings.Contains(alias, "/") {
			if authority["kind"] != "participant-cleanup" || authority["participantId"] != alias {
				t.Error("cleanup used public participant identity")
			}
			media.owners = append(media.owners, alias)
		}
		response.WriteHeader(204)
		return
	}
	if strings.HasSuffix(request.URL.Path, "/capabilities") {
		_ = json.NewEncoder(response).Encode(map[string]any{"roomId": "room_a", "routerCapabilities": map[string]any{"codecs": []any{}}})
		return
	}
	if media.delay != 0 {
		time.Sleep(media.delay)
	}
	if media.status != 0 {
		response.WriteHeader(media.status)
		return
	}
	if media.malformed {
		response.WriteHeader(201)
		_, _ = response.Write([]byte(`{"roomId":"another_room"}`))
		return
	}
	switch {
	case request.Method == "GET" && request.URL.Path == base+"/tracks":
		_ = json.NewEncoder(response).Encode(map[string]any{"roomId": "room_a", "tracks": []any{map[string]any{"id": "media_track", "participantId": "session_a"}}})
	case strings.HasSuffix(request.URL.Path, "/restart-ice"):
		_ = json.NewEncoder(response).Encode(map[string]any{"iceParameters": transportResult()["iceParameters"]})
	case request.URL.Path == base+"/transports":
		result := transportResult()
		result["direction"] = body["direction"]
		response.WriteHeader(201)
		_ = json.NewEncoder(response).Encode(result)
	case request.URL.Path == base+"/tracks":
		response.WriteHeader(201)
		_ = json.NewEncoder(response).Encode(map[string]any{"roomId": "room_a", "track": map[string]any{"id": "media_track", "kind": body["kind"], "participantId": body["participantId"], "trackType": body["trackType"], "priority": "normal"}})
	case request.URL.Path == base+"/subscriptions":
		response.WriteHeader(201)
		_ = json.NewEncoder(response).Encode(map[string]any{"roomId": "room_a", "subscription": map[string]any{"id": "media_subscription", "producerId": body["trackId"], "trackId": body["trackId"], "trackType": "audio", "kind": "audio", "rtpParameters": map[string]any{}}})
	default:
		response.WriteHeader(204)
	}
}

func newTestAdapter(t *testing.T) (*Adapter, *memoryRoom, *testMedia) {
	t.Helper()
	room := newMemoryRoom()
	media := &testMedia{calls: map[string]int{}, nodeID: "media-local"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { media.serve(t, w, r) }))
	t.Cleanup(server.Close)
	httpMedia, err := NewMediaHTTP(server.URL+"/internal/v1", adapterSecret)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(httpMedia.Close)
	adapter, err := NewAdapter(room, httpMedia, "media-local")
	if err != nil {
		t.Fatal(err)
	}
	return adapter, room, media
}

func TestAdapterSerializesAllocationAndReplaysAcrossReconstruction(t *testing.T) {
	adapter, room, media := newTestAdapter(t)
	request := adapterRequest("create", "rtc.transport.create", "session_a", map[string]any{"direction": "send"})
	var wg sync.WaitGroup
	responses := make(chan Response, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := adapter.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request)
			if err != nil {
				t.Error(err)
			}
			responses <- result
		}()
	}
	wg.Wait()
	close(responses)
	var first Response
	for result := range responses {
		if first.Type == "" {
			first = result
		}
		if !reflect.DeepEqual(first, result) {
			t.Fatal("replay changed the response")
		}
	}
	if first.Payload["transportId"] == "media_transport" {
		t.Fatal("internal ID leaked")
	}
	if media.calls["POST /internal/v1/rooms/room_a/transports"] != 1 || media.calls["POST /internal/v1/rooms/room_a"] != 1 {
		t.Fatal("duplicate allocation")
	}
	reconstructed, _ := NewAdapter(room, adapter.media, "media-local")
	result, err := reconstructed.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request)
	if err != nil || !reflect.DeepEqual(result, first) {
		t.Fatal("reconstructed adapter lost receipts")
	}
	request.Payload = adapterRequest("create", "rtc.transport.create", "session_a", map[string]any{"direction": "receive"}).Payload
	if _, err := adapter.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request); !errors.Is(err, ErrRequestConflict) {
		t.Fatal("request ID reuse accepted")
	}
}

func TestAdapterNegotiatesAndProtectsSessionResources(t *testing.T) {
	adapter, _, media := newTestAdapter(t)
	ctx := context.Background()
	call := func(id, kind, session, participant string, payload map[string]any) Response {
		t.Helper()
		result, err := adapter.Handle(ctx, adapterClaims(participant), session, adapterRequest(id, kind, session, payload))
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	send := call("send", "rtc.transport.create", "session_a", "participant_a", map[string]any{"direction": "send"}).Payload["transportId"]
	if _, err := adapter.Handle(ctx, adapterClaims("participant_b"), "session_b", adapterRequest("steal", "rtc.ice.restart", "session_b", map[string]any{"transportId": send})); !errors.Is(err, ErrForbidden) {
		t.Fatal("cross-session transport accepted")
	}
	call("connect", "rtc.transport.connect", "session_a", "participant_a", map[string]any{"transportId": send, "dtlsParameters": transportResult()["dtlsParameters"]})
	call("ice", "rtc.ice.restart", "session_a", "participant_a", map[string]any{"transportId": send})
	track := call("publish", "rtc.track.publish", "session_a", "participant_a", map[string]any{"transportId": send, "trackType": "audio", "rtpParameters": map[string]any{}, "metadata": map[string]any{"label": "voice"}}).Payload["track"].(map[string]any)
	if track["participantId"] != "participant_a" || track["sessionId"] != "session_a" || track["id"] == "media_track" {
		t.Fatal("incorrect public track identity")
	}
	receive := call("receive", "rtc.transport.create", "session_b", "participant_b", map[string]any{"direction": "receive"}).Payload["transportId"]
	subscription := call("subscribe", "rtc.track.subscribe", "session_b", "participant_b", map[string]any{"transportId": receive, "trackId": track["id"], "rtpCapabilities": map[string]any{}}).Payload["subscriptionId"]
	call("resume", "rtc.subscription.resume", "session_b", "participant_b", map[string]any{"subscriptionId": subscription})
	for _, action := range []string{"pause", "resume"} {
		controlled := call("control_"+action, "rtc.track.control", "session_a", "participant_a", map[string]any{"trackId": track["id"], "action": action}).Payload["track"].(map[string]any)
		tracks, _, err := adapter.Discover(ctx, adapterClaims("participant_b"), "session_b")
		if err != nil || len(tracks) != 1 || tracks[0].(map[string]any)["state"] != controlled["state"] {
			t.Fatalf("controlled publication missing from snapshot: tracks=%v err=%v", tracks, err)
		}
	}
	if _, err := adapter.Handle(ctx, adapterClaims("participant_b"), "session_b", adapterRequest("remove_other", "rtc.track.control", "session_b", map[string]any{"trackId": track["id"], "action": "unpublish"})); !errors.Is(err, ErrForbidden) {
		t.Fatal("cross-session unpublish accepted")
	}
	call("unpublish", "rtc.track.control", "session_a", "participant_a", map[string]any{"trackId": track["id"], "action": "unpublish"})
	if err := adapter.RemoveSession(ctx, "room_a", "participant_a", "session_a"); err != nil {
		t.Fatal(err)
	}
	call("receiver_live", "rtc.ice.restart", "session_b", "participant_b", map[string]any{"transportId": receive})
	if !reflect.DeepEqual(media.owners, []string{"session_a"}) {
		t.Fatal("cleanup was not isolated to the session")
	}
	if err := adapter.CloseRoom(ctx, "room_a"); err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.Handle(ctx, adapterClaims("participant_b"), "session_b", adapterRequest("closed", "rtc.capabilities.get", "session_b", nil)); !errors.Is(err, ErrUnavailable) {
		t.Fatal("closed room was reallocated")
	}
}

func TestAdapterAmbiguousMutationsNeverRetry(t *testing.T) {
	for _, scenario := range []string{"timeout", "malformed", "server_failure"} {
		t.Run(scenario, func(t *testing.T) {
			adapter, room, media := newTestAdapter(t)
			switch scenario {
			case "timeout":
				media.delay = 60 * time.Millisecond
				adapter.media.client.Timeout = 15 * time.Millisecond
			case "malformed":
				media.malformed = true
			case "server_failure":
				media.status = 503
			}
			request := adapterRequest("uncertain", "rtc.transport.create", "session_a", map[string]any{"direction": "send"})
			if _, err := adapter.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request); !errors.Is(err, ErrUnavailable) {
				t.Fatalf("unexpected failure: %v", err)
			}
			media.mu.Lock()
			media.delay = 0
			media.malformed = false
			media.status = 0
			media.mu.Unlock()
			adapter.media.client.Timeout = time.Second
			if _, err := adapter.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request); !errors.Is(err, ErrUnavailable) {
				t.Fatal("uncertain request was retried")
			}
			if media.calls["POST /internal/v1/rooms/room_a/transports"] != 1 {
				t.Fatal("duplicate side effect")
			}
			if room.state.Sessions["session_a"].Pending || len(room.state.Sessions["session_a"].Transports) != 0 {
				t.Fatal("uncertain resources survived cleanup")
			}
		})
	}
}

func TestAdapterReconcilesMissingMediaRoom(t *testing.T) {
	adapter, room, media := newTestAdapter(t)
	request := adapterRequest("transport", "rtc.transport.create", "session_a", map[string]any{"direction": "send"})
	if _, err := adapter.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request); err != nil {
		t.Fatal(err)
	}
	generation := room.state.Generation
	media.room = false
	if _, err := adapter.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request); !errors.Is(err, ErrUnavailable) {
		t.Fatal("stale replay accepted after media restart")
	}
	if room.state.Generation == generation || len(room.state.Sessions) != 0 {
		t.Fatal("stale generation survived")
	}
	request.RequestID = "new_generation"
	if _, err := adapter.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request); err != nil {
		t.Fatal(err)
	}
}

func TestAdapterRejectsUntrustedScopesAndMisplacedNode(t *testing.T) {
	adapter, _, media := newTestAdapter(t)
	request := adapterRequest("caps", "rtc.capabilities.get", "session_a", nil)
	claims := adapterClaims("participant_a")
	claims.EnvironmentID = "other"
	if _, err := adapter.Handle(context.Background(), claims, "session_a", request); !errors.Is(err, ErrForbidden) {
		t.Fatal("cross-environment request accepted")
	}
	media.nodeID = "wrong-node"
	if _, err := adapter.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request); !errors.Is(err, ErrUnavailable) {
		t.Fatal("placement on wrong node accepted")
	}
	if len(media.calls) != 0 {
		t.Fatal("untrusted request allocated media")
	}
}

func TestAdapterDoesNotAllocateForUnallocatedRoomEnd(t *testing.T) {
	adapter, _, media := newTestAdapter(t)
	if err := adapter.CloseRoom(context.Background(), "room_a"); err != nil {
		t.Fatal(err)
	}
	if len(media.calls) != 0 {
		t.Fatal("ending an unallocated room contacted media")
	}
}

func TestAdapterReleasesFailedAllocationClaim(t *testing.T) {
	adapter, room, media := newTestAdapter(t)
	media.allocationStatus = 503
	request := adapterRequest("allocate", "rtc.capabilities.get", "session_a", nil)
	if _, err := adapter.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request); !errors.Is(err, ErrUnavailable) {
		t.Fatal("failed allocation was accepted")
	}
	if room.state.Generation != "" || room.state.MediaNodeID != "" || room.state.Allocating {
		t.Fatal("failed allocation kept its claim")
	}
	media.allocationStatus = 0
	if _, err := adapter.Handle(context.Background(), adapterClaims("participant_a"), "session_a", request); err != nil {
		t.Fatal(err)
	}
}

func TestNativeCandidatesRespectPublicContract(t *testing.T) {
	var result map[string]any
	encoded, _ := json.Marshal(transportResult())
	_ = json.Unmarshal(encoded, &result)
	candidate := result["iceCandidates"].([]any)[0].(map[string]any)
	candidate["address"] = candidate["ip"]
	projected, ok := publicCandidates(result["iceCandidates"])
	if !ok || projected[0].(map[string]any)["address"] != nil {
		t.Fatal("native address field leaked into the strict public contract")
	}
	candidate["address"] = "different-host"
	if _, ok := publicCandidates(result["iceCandidates"]); ok {
		t.Fatal("conflicting native candidate addresses accepted")
	}
}

func TestMediaHTTPFailureMappingAndRedirectBoundary(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 429, 501, 503, 302} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			redirected := false
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected = true; w.WriteHeader(204) }))
			defer target.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(status)
			}))
			defer server.Close()
			media, _ := NewMediaHTTP(server.URL+"/internal/v1", adapterSecret)
			defer media.Close()
			_, err := media.Execute(context.Background(), Command{Method: "POST", Path: "/internal/v1/rooms/room_a", Scope: Scope{RoomID: "room_a"}, Request: Operation{Operation: "room.create"}})
			wanted := ErrUnavailable
			switch status {
			case 400:
				wanted = ErrInvalidRequest
			case 403:
				wanted = ErrForbidden
			case 501:
				wanted = ErrUnsupported
			}
			if !errors.Is(err, wanted) || redirected {
				t.Fatal("wrong failure mapping or credentials followed a redirect")
			}
		})
	}
}
