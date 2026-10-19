package rtc

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

type fixture struct {
	Name        string        `json:"name"`
	Lifecycle   bool          `json:"lifecycle"`
	Scope       Scope         `json:"scope"`
	Permissions []string      `json:"permissions"`
	Request     SignalRequest `json:"request"`
	Resources   Resources     `json:"resources"`
	Expected    Command       `json:"expected"`
}

func fixtures(t *testing.T) []fixture {
	t.Helper()
	data, err := os.ReadFile("../../../../packages/protocol/fixtures/rtc-runtime.json")
	if err != nil {
		t.Fatal(err)
	}
	var result []fixture
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func claimsFor(value fixture) auth.Claims {
	return auth.Claims{ProjectID: value.Scope.ProjectID, EnvironmentID: value.Scope.EnvironmentID, RoomID: value.Scope.RoomID, ParticipantID: value.Scope.ParticipantID, Permissions: value.Permissions}
}

func TestSharedRuntimeTranslationFixtures(t *testing.T) {
	for _, value := range fixtures(t) {
		t.Run(value.Name, func(t *testing.T) {
			var command Command
			var err error
			if value.Lifecycle {
				command, err = LifecycleCommand(value.Request.Type, value.Scope, value.Request.RequestID)
			} else {
				command, err = Plan(value.Request, claimsFor(value), value.Scope, value.Resources)
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(command, value.Expected) {
				t.Fatalf("translation mismatch: got %+v, want %+v", command, value.Expected)
			}
			encoded, err := json.Marshal(command)
			authority := command.Authority()
			if authority["roomId"] != value.Scope.RoomID {
				t.Fatal("control grant is not room scoped")
			}
			if !value.Lifecycle && (authority["participantId"] != value.Scope.SessionID || authority["sessionId"] != value.Scope.SessionID) {
				t.Fatal("control grant is not session scoped")
			}
			if err != nil {
				t.Fatal(err)
			}
			var decoded Command
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(decoded, value.Expected) {
				t.Fatal("Go JSON differs from the shared TypeScript contract")
			}
		})
	}
}

func TestRejectsUntrustedScopesAndResources(t *testing.T) {
	for _, change := range []struct {
		name  string
		apply func(*fixture, *auth.Claims)
	}{
		{"tenant", func(f *fixture, c *auth.Claims) { c.ProjectID = "project_other" }},
		{"environment", func(f *fixture, c *auth.Claims) { c.EnvironmentID = "env_other" }},
		{"room", func(f *fixture, c *auth.Claims) { c.RoomID = "room_other" }},
		{"participant", func(f *fixture, c *auth.Claims) { c.ParticipantID = "participant_other" }},
		{"join permission", func(f *fixture, c *auth.Claims) { c.Permissions = nil }},
		{"transport session", func(f *fixture, c *auth.Claims) { f.Resources.Transport.SessionID = "session_other" }},
		{"transport node", func(f *fixture, c *auth.Claims) { f.Resources.Transport.MediaNodeID = "node_other" }},
		{"transport generation", func(f *fixture, c *auth.Claims) { f.Resources.Transport.Generation = "generation_other" }},
		{"transport room", func(f *fixture, c *auth.Claims) { f.Resources.Transport.RoomID = "room_other" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			value := fixtures(t)[2]
			claims := claimsFor(value)
			change.apply(&value, &claims)
			if _, err := Plan(value.Request, claims, value.Scope, value.Resources); !errors.Is(err, ErrForbidden) {
				t.Fatalf("got %v, wanted forbidden", err)
			}
		})
	}
}

func TestRejectsMalformedAndUnsupportedRequests(t *testing.T) {
	for _, value := range []struct {
		payload  string
		expected error
	}{
		{`null`, ErrInvalidRequest},
		{`{"roomId":"room_rtc","sessionId":"session_rtc","direction":"send","participantId":"attacker"}`, ErrInvalidRequest},
		{`{"roomId":"room_rtc","sessionId":"session_other","direction":"send"}`, ErrForbidden},
		{`{"roomId":"room_rtc","sessionId":"session_rtc","direction":"invalid"}`, ErrInvalidRequest},
	} {
		f := fixtures(t)[1]
		f.Request.Payload = json.RawMessage(value.payload)
		if _, err := Plan(f.Request, claimsFor(f), f.Scope, f.Resources); !errors.Is(err, value.expected) {
			t.Fatalf("got %v, want %v", err, value.expected)
		}
	}
	for _, action := range []string{"pause", "resume"} {
		f := fixtures(t)[5]
		f.Request.Payload = json.RawMessage(`{"roomId":"room_rtc","sessionId":"session_rtc","trackId":"track_public","action":"` + action + `"}`)
		command, err := Plan(f.Request, claimsFor(f), f.Scope, f.Resources)
		if err != nil || command.Method != "PATCH" || command.Request.Operation != "track."+action || command.ResponseType != "rtc.track.control.accepted" {
			t.Fatalf("control %s: command=%+v error=%v", action, command, err)
		}
	}
	f := fixtures(t)[7]
	f.Permissions = []string{"room:join"}
	if _, err := Plan(f.Request, claimsFor(f), f.Scope, f.Resources); !errors.Is(err, ErrForbidden) {
		t.Fatalf("publish permission: %v", err)
	}
	f.Permissions = []string{"room:join", "audio:publish"}
	f.Request.Payload = json.RawMessage(`{"roomId":"room_rtc","sessionId":"session_rtc","transportId":"transport_public","trackType":"data","rtpParameters":{}}`)
	if _, err := Plan(f.Request, claimsFor(f), f.Scope, f.Resources); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("data publish: %v", err)
	}
}

func TestTrackAndConsumerOwnership(t *testing.T) {
	f := fixtures(t)[5]
	f.Resources.Track.SessionID = "session_peer"
	if _, err := Plan(f.Request, claimsFor(f), f.Scope, f.Resources); !errors.Is(err, ErrForbidden) {
		t.Fatalf("controlling peer track: %v", err)
	}
	f = fixtures(t)[6]
	f.Resources.Subscription.SessionID = "session_peer"
	if _, err := Plan(f.Request, claimsFor(f), f.Scope, f.Resources); !errors.Is(err, ErrForbidden) {
		t.Fatalf("resuming peer consumer: %v", err)
	}
	f = fixtures(t)[4]
	f.Resources.Transport.Direction = "send"
	if _, err := Plan(f.Request, claimsFor(f), f.Scope, f.Resources); !errors.Is(err, ErrForbidden) {
		t.Fatalf("subscribing on send transport: %v", err)
	}
}

func TestAllocationCannotSucceedOnFailureOrWrongNode(t *testing.T) {
	placement := Placement{RoomID: "room_rtc", MediaNodeID: "media_rtc", Generation: "generation_rtc", State: "allocating"}
	for _, result := range []struct {
		node string
		err  error
	}{{"media_rtc", errors.New("capacity exhausted")}, {"media_other", nil}} {
		got, err := CompleteAllocation(placement, result.node, result.err)
		if !errors.Is(err, ErrUnavailable) || got.State == "ready" {
			t.Fatal("failed allocation became ready")
		}
	}
	ready, err := CompleteAllocation(placement, "media_rtc", nil)
	if err != nil || ready.State != "ready" || ready.Generation != placement.Generation {
		t.Fatalf("allocation: %+v %v", ready, err)
	}
	placement.State = "closing"
	if _, err := CompleteAllocation(placement, "media_rtc", nil); !errors.Is(err, ErrUnavailable) {
		t.Fatal("fenced room became ready")
	}
}

func TestRetryFingerprintsBindPayloadAndRoomGeneration(t *testing.T) {
	f := fixtures(t)[1]
	first, err := RequestFingerprint(f.Scope, f.Request)
	if err != nil {
		t.Fatal(err)
	}
	f.Request.Payload = json.RawMessage(`{ "direction": "send", "sessionId": "session_rtc", "roomId": "room_rtc" }`)
	same, err := RequestFingerprint(f.Scope, f.Request)
	if err != nil || same != first {
		t.Fatal("formatting changed retry identity")
	}
	f.Request.Payload = json.RawMessage(`{"direction":"receive","sessionId":"session_rtc","roomId":"room_rtc"}`)
	different, err := RequestFingerprint(f.Scope, f.Request)
	if err != nil || different == first {
		t.Fatal("changed payload reused retry identity")
	}
	f.Scope.Generation = "generation_new"
	changedGeneration, err := RequestFingerprint(f.Scope, f.Request)
	if err != nil || different == changedGeneration {
		t.Fatal("stale generation reused retry identity")
	}
}

func TestProtocolFailuresDoNotExposeBackendErrors(t *testing.T) {
	for _, value := range []struct {
		err       error
		code      string
		retryable bool
	}{
		{ErrForbidden, "forbidden", false}, {ErrInvalidRequest, "invalid_message", false}, {ErrUnsupported, "invalid_message", false},
		{ErrRequestConflict, "conflict", false}, {ErrUnavailable, "temporarily_unavailable", true}, {errors.New("private backend connection details"), "internal_error", false},
	} {
		failure := FailureFor(value.err)
		if failure.Code != value.code || failure.Retryable != value.retryable || failure.Message == "private backend connection details" {
			t.Fatalf("failure mapping: %+v", failure)
		}
	}
}
