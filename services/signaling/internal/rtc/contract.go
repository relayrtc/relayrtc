package rtc

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
)

var ErrForbidden = errors.New("RTC resource does not belong to this session")
var ErrInvalidRequest = errors.New("invalid RTC request")
var ErrUnsupported = errors.New("unsupported RTC operation")
var ErrUnavailable = errors.New("RTC allocation unavailable")
var ErrCapacityExceeded = fmt.Errorf("%w: resource capacity exhausted", ErrUnavailable)
var ErrRequestConflict = errors.New("RTC request ID was reused with a different payload")

type Scope struct {
	ProjectID          string `json:"projectId"`
	EnvironmentID      string `json:"environmentId"`
	RoomID             string `json:"roomId"`
	ParticipantID      string `json:"participantId,omitempty"`
	SessionID          string `json:"sessionId,omitempty"`
	MediaNodeID        string `json:"mediaNodeId"`
	Generation         string `json:"generation"`
	MediaParticipantID string `json:"mediaParticipantId,omitempty"`
}

type Placement struct {
	RoomID      string
	MediaNodeID string
	Generation  string
	State       string
}

type TransportBinding struct {
	ID          string
	MediaID     string
	RoomID      string
	SessionID   string
	MediaNodeID string
	Direction   string
	Generation  string
}

type TrackBinding struct {
	ParticipantID string
	Type          string
	State         string
	Priority      string
	Metadata      map[string]any
	PublishedAt   time.Time
	UnpublishedAt *time.Time
	Generation    string
	ID            string
	MediaID       string
	RoomID        string
	SessionID     string
	MediaNodeID   string
}

type Resources struct {
	Transport    *TransportBinding
	Track        *TrackBinding
	Subscription *SubscriptionBinding
}

type SubscriptionBinding struct {
	TrackID     string
	TransportID string
	CreatedAt   time.Time
	Resumed     bool
	Generation  string
	ID          string
	MediaID     string
	RoomID      string
	SessionID   string
	MediaNodeID string
}

type SessionRepository interface {
	ResolveJoined(context.Context, auth.Claims, string) (Scope, error)
}

type Operation struct {
	Operation string         `json:"operation"`
	Body      map[string]any `json:"body"`
}

type Command struct {
	RequestID    string         `json:"requestId"`
	Method       string         `json:"method"`
	Path         string         `json:"path"`
	Scope        Scope          `json:"scope"`
	ResponseType string         `json:"responseType"`
	Request      Operation      `json:"request"`
	Metadata     map[string]any `json:"metadata"`
}

type PlacementRepository interface {
	Claim(context.Context, string) (Placement, error)
	Commit(context.Context, Placement) error
	Release(context.Context, Placement) error
	Fence(context.Context, string) (Placement, error)
}

func (command Command) Authority() map[string]string {
	scope := command.Scope
	switch command.Request.Operation {
	case "room.create", "room.close", "tracks.list":
		return map[string]string{"kind": "room", "roomId": scope.RoomID}
	case "participant.remove":
		return map[string]string{"kind": "participant-cleanup", "roomId": scope.RoomID, "participantId": scope.MediaParticipantID}
	default:
		return map[string]string{"kind": "participant", "subjectId": scope.ParticipantID, "roomId": scope.RoomID, "participantId": scope.MediaParticipantID, "sessionId": scope.SessionID}
	}
}

type RequestRepository interface {
	Claim(context.Context, Scope, string, string) ([]byte, error)
	Complete(context.Context, Scope, string, string, []byte) error
	MarkAmbiguous(context.Context, Scope, string) error
}

type ResourceRepository interface {
	Transport(context.Context, Scope, string) (TransportBinding, error)
	Track(context.Context, Scope, string) (TrackBinding, error)
	Subscription(context.Context, Scope, string) (SubscriptionBinding, error)
	SaveTransport(context.Context, Scope, TransportBinding) error
	SaveTrack(context.Context, Scope, TrackBinding) error
	SaveSubscription(context.Context, Scope, SubscriptionBinding) error
	RemoveSession(context.Context, Scope) error
}

func CompleteAllocation(placement Placement, mediaNodeID string, allocationError error) (Placement, error) {
	if allocationError != nil {
		return Placement{}, ErrUnavailable
	}
	if placement.State != "allocating" || placement.RoomID == "" || placement.Generation == "" || placement.MediaNodeID == "" || mediaNodeID != placement.MediaNodeID {
		return Placement{}, ErrUnavailable
	}
	placement.State = "ready"
	return placement, nil
}
