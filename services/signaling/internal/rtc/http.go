package rtc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type MediaHTTP struct {
	origin string
	secret []byte
	client *http.Client
}

type mediaFailure struct {
	status    int
	cause     error
	ambiguous bool
}

func (failure *mediaFailure) Error() string { return failure.cause.Error() }
func (failure *mediaFailure) Unwrap() error { return failure.cause }

func NewMediaHTTP(baseURL, secret string) (*MediaHTTP, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "/internal/v1" || len(secret) < 32 {
		return nil, ErrInvalidRequest
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxConnsPerHost = 16
	transport.ResponseHeaderTimeout = 3 * time.Second
	return &MediaHTTP{origin: parsed.Scheme + "://" + parsed.Host, secret: []byte(secret), client: &http.Client{
		Timeout: 4 * time.Second, Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (media *MediaHTTP) Close() { media.client.CloseIdleConnections() }

func (media *MediaHTTP) Execute(ctx context.Context, command Command) (map[string]any, error) {
	var body io.Reader
	if command.Request.Body != nil {
		encoded, err := json.Marshal(command.Request.Body)
		if err != nil {
			return nil, ErrInvalidRequest
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, command.Method, media.origin+command.Path, body)
	if err != nil {
		return nil, ErrInvalidRequest
	}
	now := time.Now().Unix()
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"aud": "relayrtc-media-control", "iss": "relayrtc-signaling", "iat": now, "exp": now + 30,
		"method": request.Method, "path": request.URL.EscapedPath(), "authority": command.Authority(),
	})
	token.Header["typ"] = "relayrtc-media-control+jwt"
	signed, err := token.SignedString(media.secret)
	if err != nil {
		return nil, ErrUnavailable
	}
	request.Header.Set("Authorization", "Bearer "+signed)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := media.client.Do(request)
	mutation := command.Method != http.MethodGet
	if err != nil {
		return nil, &mediaFailure{cause: ErrUnavailable, ambiguous: mutation}
	}
	defer response.Body.Close()
	status := http.StatusNoContent
	switch command.Request.Operation {
	case "stats.report":
		status = http.StatusAccepted
	case "room.create", "transport.create", "track.publish", "track.subscribe":
		status = http.StatusCreated
	case "capabilities.get", "tracks.list", "ice.restart", "node.ready", "node.health":
		status = http.StatusOK
	}
	if response.StatusCode != status {
		cause := ErrUnavailable
		switch response.StatusCode {
		case http.StatusBadRequest:
			cause = ErrInvalidRequest
		case http.StatusForbidden:
			cause = ErrForbidden
		case http.StatusConflict:
			cause = ErrDuplicateSubscription
		case http.StatusTooManyRequests:
			cause = ErrCapacityExceeded
		case http.StatusNotImplemented:
			cause = ErrUnsupported
		}
		return nil, &mediaFailure{status: response.StatusCode, cause: cause, ambiguous: mutation && (response.StatusCode >= 500 || response.StatusCode < 400)}
	}
	if status == http.StatusNoContent {
		return map[string]any{}, nil
	}
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 1_048_577))
	var result map[string]any
	if err != nil || len(encoded) > 1_048_576 || json.Unmarshal(encoded, &result) != nil || result == nil {
		return nil, &mediaFailure{cause: ErrUnavailable, ambiguous: mutation}
	}
	return result, nil
}

func ambiguous(err error) bool {
	var failure *mediaFailure
	return errors.As(err, &failure) && failure.ambiguous
}

func missing(err error) bool {
	var failure *mediaFailure
	return errors.As(err, &failure) && failure.status == http.StatusNotFound
}
