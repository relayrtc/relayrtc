package rtc

import "errors"

type ProtocolFailure struct {
	Code      string
	Message   string
	Retryable bool
}

func FailureFor(err error) ProtocolFailure {
	switch {
	case errors.Is(err, ErrCapacityExceeded):
		return ProtocolFailure{Code: "rate_limited", Message: "The media resource limit was reached; close unused transports or tracks before retrying", Retryable: true}
	case errors.Is(err, ErrForbidden):
		return ProtocolFailure{Code: "forbidden", Message: "The RTC resource does not belong to this room session"}
	case errors.Is(err, ErrInvalidRequest):
		return ProtocolFailure{Code: "invalid_message", Message: "The RTC request is invalid"}
	case errors.Is(err, ErrUnsupported):
		return ProtocolFailure{Code: "invalid_message", Message: "The RTC operation is not supported"}
	case errors.Is(err, ErrRequestConflict):
		return ProtocolFailure{Code: "conflict", Message: "The request ID was already used for a different operation"}
	case errors.Is(err, ErrDuplicateSubscription):
		return ProtocolFailure{Code: "conflict", Message: "This session already has a subscription to that track on the receive transport"}
	case errors.Is(err, ErrUnavailable):
		return ProtocolFailure{Code: "temporarily_unavailable", Message: "The RTC media service is not available", Retryable: true}
	default:
		return ProtocolFailure{Code: "internal_error", Message: "The RTC request could not be completed"}
	}
}
