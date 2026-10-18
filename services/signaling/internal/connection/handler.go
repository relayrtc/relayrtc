package connection

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/relayrtc/relayrtc/services/signaling/internal/auth"
	"github.com/relayrtc/relayrtc/services/signaling/internal/geolocation"
	"github.com/relayrtc/relayrtc/services/signaling/internal/rtc"
	"github.com/relayrtc/relayrtc/services/signaling/internal/session"
)

const (
	protocolVersion   = "relayrtc.v1"
	closeTokenExpired = 4001
	closeRoomEnded    = 4002
)

type Options struct {
	ResourceLimits     ResourceLimits
	TrustedProxyCIDRs  []netip.Prefix
	StoreParticipantIP bool
	AllowedOrigins     []string
	HeartbeatInterval  time.Duration
	MaxMessageBytes    int64
	NodeID             string
	LocationLookup     LocationLookup
	ParticipantMedia   ParticipantMediaService
	PongTimeout        time.Duration
	RecoveryTimeout    time.Duration
	RTCService         RTCSignalService
	SessionStore       SessionStore
	Shutdown           context.Context
	Validator          *auth.Validator
	WriteTimeout       time.Duration
}

type ParticipantMediaService interface {
	RemoveParticipant(context.Context, string, string) error
}

type SessionLocationStore interface {
	SetLocation(context.Context, string, string, string, string) error
}

type LocationLookup interface {
	Lookup(context.Context, string) (geolocation.Location, error)
}

type SessionStore interface {
	Join(context.Context, auth.Claims, string, string) (session.JoinResult, error)
	Leave(context.Context, string, string, string) (time.Time, error)
	Disconnect(context.Context, string, string) (time.Time, error)
	Resume(context.Context, auth.Claims, string, string, time.Time) (session.ResumeResult, error)
	Expire(context.Context, string, string, string) (time.Time, error)
	UpdateMetadata(context.Context, string, string, string, json.RawMessage) (session.Participant, error)
	EndRoom(context.Context, string, time.Time) error
}

type Handler struct {
	limiter            *resourceLimiter
	trustedProxyCIDRs  []netip.Prefix
	storeParticipantIP bool
	heartbeatInterval  time.Duration
	maxMessageBytes    int64
	nodeID             string
	participantMedia   ParticipantMediaService
	pongTimeout        time.Duration
	recoveries         map[string]chan struct{}
	recoveryRooms      map[string]string
	recoveryMu         sync.Mutex
	recoveryTimeout    time.Duration
	registry           *registry
	rtcService         RTCSignalService
	rtcEventsOnce      sync.Once
	sessionStore       SessionStore
	locationLookup     LocationLookup
	shutdown           context.Context
	upgrader           websocket.Upgrader
	validator          *auth.Validator
	writeTimeout       time.Duration
	wg                 sync.WaitGroup
}

type joinedSession struct {
	participant session.Participant
	session     session.ParticipantSession
}

func NewHandler(options Options) *Handler {
	if options.ResourceLimits.Connections == 0 {
		options.ResourceLimits = DefaultResourceLimits()
	}
	if options.Shutdown == nil {
		options.Shutdown = context.Background()
	}
	allowedOrigins := make(map[string]struct{}, len(options.AllowedOrigins))
	for _, origin := range options.AllowedOrigins {
		allowedOrigins[origin] = struct{}{}
	}
	recoveryTimeout := options.RecoveryTimeout
	if recoveryTimeout <= 0 {
		recoveryTimeout = 30 * time.Second
	}
	return &Handler{
		limiter:            newResourceLimiter(options.ResourceLimits),
		trustedProxyCIDRs:  append([]netip.Prefix(nil), options.TrustedProxyCIDRs...),
		storeParticipantIP: options.StoreParticipantIP,
		heartbeatInterval:  options.HeartbeatInterval,
		maxMessageBytes:    options.MaxMessageBytes,
		nodeID:             options.NodeID,
		locationLookup:     options.LocationLookup,
		participantMedia:   options.ParticipantMedia,
		pongTimeout:        options.PongTimeout,
		recoveries:         make(map[string]chan struct{}),
		recoveryRooms:      make(map[string]string),
		recoveryTimeout:    recoveryTimeout,
		registry:           newRegistry(),
		rtcService:         options.RTCService,
		sessionStore:       options.SessionStore,
		shutdown:           options.Shutdown,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(request *http.Request) bool {
				origin := request.Header.Get("Origin")
				if origin == "" {
					return true
				}
				_, ok := allowedOrigins[origin]
				return ok
			},
			HandshakeTimeout: 10 * time.Second,
			Subprotocols:     []string{protocolVersion},
		},
		validator:    options.Validator,
		writeTimeout: options.WriteTimeout,
	}
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler.shutdown.Err() != nil {
		writeHTTPError(response, http.StatusServiceUnavailable, "SIGNALING_UNAVAILABLE", "The signaling owner is unavailable")
		return
	}
	ip := scopeIP(requestClientIP(request, handler.trustedProxyCIDRs))
	if !handler.limiter.allow(rateScope{"connect:" + ip, handler.limiter.limits.ConnectsPerIPPerMinute, time.Minute}) {
		response.Header().Set("Retry-After", "60")
		writeHTTPError(response, http.StatusTooManyRequests, "RATE_LIMITED", "The connection attempt limit was reached")
		return
	}
	protocols := websocket.Subprotocols(request)
	if !contains(protocols, protocolVersion) {
		writeHTTPError(response, http.StatusBadRequest, "PROTOCOL_REQUIRED", "The relayrtc.v1 WebSocket protocol is required")
		return
	}
	rawToken, ok := auth.ExtractToken(request.Header.Get("Authorization"), protocols)
	if !ok {
		writeHTTPError(response, http.StatusUnauthorized, "AUTHENTICATION_REQUIRED", "Provide a participant token")
		return
	}
	claims, err := handler.validator.Validate(rawToken)
	if err != nil {
		writeHTTPError(response, http.StatusUnauthorized, "INVALID_PARTICIPANT_TOKEN", "The participant token is invalid or expired")
		return
	}

	release, admitted := handler.limiter.acquire(ip, claims.ProjectID, claims.RoomID)
	if !admitted {
		response.Header().Set("Retry-After", "1")
		writeHTTPError(response, http.StatusTooManyRequests, "CONNECTION_LIMIT_EXCEEDED", "Connection capacity for this IP, project or room is exhausted")
		return
	}
	defer release()
	websocketConnection, err := handler.upgrader.Upgrade(response, request, nil)
	if err != nil {
		return
	}
	client := &client{connection: websocketConnection, writeTimeout: handler.writeTimeout, rateID: newID("connection")}
	client.startWriter(handler.limiter.limits.OutboundMessages, handler.limiter.limits.OutboundBytes)
	defer client.stopWriter()
	handler.wg.Add(1)
	defer handler.wg.Done()
	handler.registry.add(client)
	defer handler.registry.remove(client)
	defer websocketConnection.Close()

	slog.Info("signaling connection accepted", "participant_id", claims.ParticipantID, "room_id", claims.RoomID)
	joined, claims := handler.serve(client, claims, rawToken, requestClientIP(request, handler.trustedProxyCIDRs))
	client.stopWriter()
	if joined != nil {
		handler.disconnect(client, joined, claims)
		handler.flushClientUsage(client, joined.session.ID)
	}
	slog.Info("signaling connection disconnected", "participant_id", claims.ParticipantID, "room_id", claims.RoomID)
}

func (handler *Handler) ActiveConnections() int { return handler.registry.len() }

func (handler *Handler) EndRoom(ctx context.Context, room session.Room) error {
	if room.EndedAt == nil || room.Status != "ended" {
		return errors.New("room must be ended before terminating its runtime")
	}
	if err := handler.sessionStore.EndRoom(ctx, room.ID, *room.EndedAt); err != nil {
		return err
	}
	if reader, ok := handler.sessionStore.(interface {
		GetRoom(context.Context, string) (session.Room, error)
	}); ok {
		stored, err := reader.GetRoom(ctx, room.ID)
		if err != nil && !errors.Is(err, session.ErrRoomNotJoinable) {
			return err
		}
		if err == nil {
			stored.Status, stored.EndedAt = "ended", room.EndedAt
			room = stored
		}
	}
	handler.recoveryMu.Lock()
	for sessionID, roomID := range handler.recoveryRooms {
		if roomID == room.ID {
			if recovery := handler.recoveries[sessionID]; recovery != nil {
				close(recovery)
			}
			delete(handler.recoveries, sessionID)
			delete(handler.recoveryRooms, sessionID)
		}
	}
	handler.recoveryMu.Unlock()
	clients := handler.registry.roomClients(room.ID)
	message := event("room.ended", map[string]any{"room": room})
	var closing []<-chan struct{}
	for _, client := range clients {
		var payload any
		if room.ProjectID != "" {
			payload = message
		}
		closing = append(closing, client.end(payload, closeRoomEnded, "room ended"))
		client.operationMu.Lock()
		client.operationMu.Unlock()
	}
	for _, done := range closing {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if runtime, ok := handler.rtcService.(RTCSessionLifecycle); ok {
		return runtime.CloseRoom(ctx, room.ID)
	}
	return nil
}

func (handler *Handler) Wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() { handler.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (handler *Handler) serve(client *client, claims auth.Claims, rawToken, clientIP string) (*joinedSession, auth.Claims) {
	client.connection.SetReadLimit(handler.maxMessageBytes)
	_ = client.connection.SetReadDeadline(time.Now().Add(handler.pongTimeout))
	client.connection.SetPongHandler(func(string) error {
		return client.connection.SetReadDeadline(time.Now().Add(handler.pongTimeout))
	})

	readContext, cancelRead := context.WithCancel(context.Background())
	defer cancelRead()
	read := make(chan incoming)
	go readPump(readContext, client.connection, read)
	heartbeat := time.NewTicker(handler.heartbeatInterval)
	defer heartbeat.Stop()
	usage := time.NewTicker(2 * time.Second)
	defer usage.Stop()
	expires := time.NewTimer(time.Until(claims.ExpiresAt.Time))
	defer expires.Stop()
	var joined *joinedSession

	for {
		select {
		case <-handler.shutdown.Done():
			client.close(websocket.CloseGoingAway, "server shutting down")
			return joined, claims
		case <-expires.C:
			client.close(closeTokenExpired, "participant token expired")
			return joined, claims
		case message := <-read:
			if message.err != nil {
				return joined, claims
			}
			if !handler.limiter.allow(
				rateScope{"message-node", handler.limiter.limits.MessagesPerNode, time.Second},
				rateScope{"message-session:" + client.rateID, handler.limiter.limits.MessagesPerConnection, time.Second},
				rateScope{"message-ip:" + scopeIP(clientIP), handler.limiter.limits.MessagesPerIP, time.Second},
				rateScope{"message-project:" + claims.ProjectID, handler.limiter.limits.MessagesPerProject, time.Second},
				rateScope{"message-room:" + claims.ProjectID + ":" + claims.RoomID, handler.limiter.limits.MessagesPerRoom, time.Second},
			) {
				client.protocolError("", "rate_limited", "The message rate limit was reached; reconnect after a short delay")
				client.close(websocket.ClosePolicyViolation, "message rate limit exceeded")
				return joined, claims
			}
			client.recordMessageReceived()
			if handled, refreshed := handler.tryRefresh(client, claims, joined, message.data); handled {
				if refreshed != nil {
					claims, rawToken = refreshed.claims, refreshed.token
					expires.Reset(time.Until(claims.ExpiresAt.Time))
				}
				if client.isRevoked() {
					select {
					case <-client.writerDone:
					case <-time.After(handler.writeTimeout):
					}
					return joined, claims
				}
				continue
			}
			leave, next := handler.handleMessage(client, claims, rawToken, joined, clientIP, message.data)
			if next != nil {
				joined = next
			}
			if leave {
				if joined != nil {
					handler.flushClientUsage(client, joined.session.ID)
				}
				return nil, claims
			}
		case <-usage.C:
			if joined != nil && !handler.guestAuthorized(claims) {
				ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
				_ = handler.RemoveParticipantSession(ctx, claims.RoomID, claims.ParticipantID, joined.session.ID)
				cancel()
				return joined, claims
			}
			if joined != nil {
				handler.flushClientUsage(client, joined.session.ID)
			}
		case now := <-heartbeat.C:
			if err := client.control(websocket.PingMessage, []byte(now.UTC().Format(time.RFC3339Nano))); err != nil {
				return joined, claims
			}
		}
	}
}

func (handler *Handler) flushClientUsage(client *client, sessionID string) {
	recorder, ok := handler.sessionStore.(interface {
		RecordUsageSample(context.Context, string, string, int64, int64) error
	})
	if !ok {
		return
	}
	client.usageMu.Lock()
	defer client.usageMu.Unlock()
	for attempt := 0; attempt < 2; attempt++ {
		if client.pendingUsage == nil {
			incoming, outgoing := client.drainUsage()
			if incoming == 0 && outgoing == 0 {
				return
			}
			client.pendingUsage = &usageSample{id: newID("usage"), incoming: incoming, outgoing: outgoing}
		}
		pending := client.pendingUsage
		usageContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := recorder.RecordUsageSample(usageContext, sessionID, pending.id, pending.incoming, pending.outgoing)
		cancel()
		if err != nil {
			slog.Warn("signaling usage persistence failed", "error", err, "session_id", sessionID)
			return
		}
		client.pendingUsage = nil
	}
}

func (handler *Handler) recordSessionLocation(sessionID, clientIP string) {
	recorder, ok := handler.sessionStore.(SessionLocationStore)
	if !ok || clientIP == "" || (!handler.storeParticipantIP && handler.locationLookup == nil) {
		return
	}

	handler.wg.Add(1)
	go func() {
		defer handler.wg.Done()
		parent := handler.shutdown
		if parent == nil {
			parent = context.Background()
		}
		ctx, cancel := context.WithTimeout(parent, 3*time.Second)
		defer cancel()

		location := geolocation.Location{}
		if handler.locationLookup != nil {
			resolved, err := handler.locationLookup.Lookup(ctx, clientIP)
			if err != nil {
				slog.Warn("participant location lookup failed")
			} else {
				location = resolved
			}
		}

		storedIP := ""
		if handler.storeParticipantIP {
			storedIP = clientIP
		}
		if err := recorder.SetLocation(ctx, sessionID, storedIP, location.CountryCode, location.Country); err != nil {
			slog.Warn("participant location persistence failed", "session_id", sessionID)
		}
	}()
}

func (handler *Handler) guestAuthorized(claims auth.Claims) bool {
	verifier, ok := handler.sessionStore.(interface {
		AuthorizeGuest(context.Context, auth.Claims) bool
	})
	if !ok {
		return !strings.HasPrefix(claims.ParticipantID, "guestp_")
	}
	ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
	defer cancel()
	return verifier.AuthorizeGuest(ctx, claims)
}

func (handler *Handler) handleMessage(client *client, claims auth.Claims, rawToken string, joined *joinedSession, clientIP string, data []byte) (bool, *joinedSession) {
	client.operationMu.Lock()
	defer client.operationMu.Unlock()
	if client.isRevoked() || !handler.guestAuthorized(claims) {
		client.rejectRevoked()
		return true, joined
	}
	if joined != nil {
		ctx, cancel := context.WithTimeout(handler.shutdown, 2*time.Second)
		active := handler.sessionActive(ctx, claims.RoomID, claims.ParticipantID, joined.session.ID)
		cancel()
		if !active {
			client.rejectRevoked()
			return true, joined
		}
	}
	request := requestEnvelope{}
	if err := json.Unmarshal(data, &request); err != nil || request.Version != 1 || request.ID == "" {
		client.protocolError(request.ID, "invalid_message", "The protocol message is invalid")
		return false, nil
	}

	switch request.Type {
	case "heartbeat.ping":
		payload := heartbeatPayload{}
		if json.Unmarshal(request.Payload, &payload) != nil || payload.Nonce == "" {
			client.protocolError(request.ID, "invalid_message", "The heartbeat payload is invalid")
			return false, nil
		}
		client.response(request.ID, "heartbeat.pong", map[string]any{"nonce": payload.Nonce, "serverTime": time.Now().UTC()})
	case "participant.join":
		if joined != nil || handler.sessionStore == nil {
			client.protocolError(request.ID, "conflict", "The connection has already joined a room")
			return false, nil
		}
		payload := joinPayload{}
		if json.Unmarshal(request.Payload, &payload) != nil || payload.RoomID != claims.RoomID ||
			subtle.ConstantTimeCompare([]byte(payload.ParticipantToken), []byte(rawToken)) != 1 {
			client.protocolError(request.ID, "forbidden", "The join request does not match the participant token")
			return false, nil
		}
		operationContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		result, err := handler.sessionStore.Join(operationContext, claims, newID("session"), handler.nodeID)
		cancel()
		if err != nil {
			client.protocolError(request.ID, sessionErrorCode(err), sessionErrorMessage(err))
			return false, nil
		}
		handler.recordSessionLocation(result.Session.ID, clientIP)
		next := &joinedSession{participant: result.Participant, session: result.Session}
		if !handler.registry.claimSession(result.Session.ID, client) {
			client.protocolError(request.ID, "conflict", "The participant session is already connected")
			return false, nil
		}
		handler.registry.join(claims.RoomID, client)
		client.rtcSessionID = result.Session.ID
		if err := handler.acceptWithTracks(client, claims, result.Session.ID, request.ID, "participant.join.accepted", map[string]any{
			"room": result.Room, "localParticipant": result.Participant, "session": result.Session,
			"participants": result.Participants,
		}); err != nil {
			handler.disconnect(client, next, claims)
			client.protocolError(request.ID, "temporarily_unavailable", "The room tracks could not be loaded")
			client.close(websocket.CloseGoingAway, "join could not complete")
			return true, nil
		}
		handler.registry.broadcast(claims.RoomID, client, event("participant.joined", map[string]any{"participant": result.Participant}))
		return false, next
	case "session.resume":
		if joined != nil || handler.sessionStore == nil {
			client.protocolError(request.ID, "conflict", "The connection already owns a room session")
			return false, joined
		}
		payload := resumePayload{}
		if json.Unmarshal(request.Payload, &payload) != nil || payload.RoomID != claims.RoomID ||
			subtle.ConstantTimeCompare([]byte(payload.ResumeToken), []byte(rawToken)) != 1 {
			client.protocolError(request.ID, "forbidden", "The resume request does not match the participant token")
			return false, nil
		}
		operationContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		result, err := handler.sessionStore.Resume(
			operationContext, claims, payload.SessionID, handler.nodeID,
			time.Now().UTC().Add(-handler.recoveryTimeout),
		)
		cancel()
		if err != nil {
			client.protocolError(request.ID, sessionErrorCode(err), sessionErrorMessage(err))
			return false, nil
		}
		if !handler.registry.claimSession(result.Session.ID, client) {
			client.protocolError(request.ID, "conflict", "The participant session is already connected")
			return false, nil
		}
		handler.cancelRecovery(result.Session.ID)
		handler.registry.join(claims.RoomID, client)
		next := &joinedSession{participant: result.Participant, session: result.Session}
		client.rtcSessionID = result.Session.ID
		if err := handler.acceptWithTracks(client, claims, result.Session.ID, request.ID, "session.resume.accepted", map[string]any{
			"roomId": claims.RoomID, "session": result.Session,
			"participants": result.Participants,
		}); err != nil {
			handler.disconnect(client, next, claims)
			client.protocolError(request.ID, "temporarily_unavailable", "The room tracks could not be loaded")
			client.close(websocket.CloseGoingAway, "resume could not complete")
			return true, nil
		}
		handler.registry.broadcast(claims.RoomID, client, event("participant.reconnected", map[string]any{
			"participantId": claims.ParticipantID, "session": result.Session,
		}))
		return false, next
	case "participant.leave":
		payload := leavePayload{}
		if joined == nil || json.Unmarshal(request.Payload, &payload) != nil ||
			payload.RoomID != claims.RoomID || payload.ParticipantID != claims.ParticipantID ||
			payload.SessionID != joined.session.ID {
			client.protocolError(request.ID, "forbidden", "The leave request does not match this session")
			return false, nil
		}
		operationContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		leftAt, err := handler.sessionStore.Leave(operationContext, claims.RoomID, claims.ParticipantID, joined.session.ID)
		cancel()
		if err != nil {
			client.protocolError(request.ID, "internal_error", "The participant could not leave")
			return false, nil
		}
		cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 5*time.Second)
		if cleanupErr := handler.removeSessionMedia(cleanupContext, claims.RoomID, claims.ParticipantID, joined.session.ID); cleanupErr != nil {
			slog.Warn("participant media cleanup failed", "error", cleanupErr, "roomId", claims.RoomID)
		}
		cancelCleanup()
		leavePayload := map[string]any{"roomId": claims.RoomID, "participantId": claims.ParticipantID, "sessionId": joined.session.ID, "leftAt": leftAt}
		client.response(request.ID, "participant.leave.accepted", leavePayload)
		handler.registry.broadcast(claims.RoomID, client, event("participant.left", leavePayload))
		handler.registry.leave(claims.RoomID, client)
		handler.registry.releaseSession(joined.session.ID, client)
		client.close(websocket.CloseNormalClosure, "participant left")
		return true, nil
	case "participant.metadata.update":
		handler.handleMetadataUpdate(client, claims, joined, request)
		return false, joined
	case "message.send", "event.emit":
		handler.handleMessagingMessage(client, claims, joined, request)
		return false, joined
	default:
		if _, ok := rtcResponseTypes[request.Type]; ok {
			handler.handleRTCMessage(client, claims, joined, request)
			return false, joined
		}
		client.protocolError(request.ID, "invalid_message", "The protocol message type is unsupported")
	}
	return false, nil
}

func (handler *Handler) handleRTCMessage(client *client, claims auth.Claims, joined *joinedSession, request requestEnvelope) {
	if joined == nil {
		client.protocolError(request.ID, "forbidden", "Join the room before RTC negotiation")
		return
	}
	scope := rtcSessionScope{}
	if json.Unmarshal(request.Payload, &scope) != nil || scope.RoomID != claims.RoomID ||
		scope.SessionID != joined.session.ID {
		client.protocolError(request.ID, "forbidden", "The RTC request does not match this room session")
		return
	}
	if request.Type == "rtc.track.publish" {
		publication := rtcTrackPublishScope{}
		if json.Unmarshal(request.Payload, &publication) != nil ||
			!hasPermission(claims.Permissions, publication.permission()) {
			client.protocolError(request.ID, "forbidden", "The participant cannot publish this track")
			return
		}
	}
	if handler.rtcService == nil {
		client.protocolError(request.ID, "temporarily_unavailable", "The RTC media service is not available")
		return
	}

	operationContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	response, err := handler.rtcService.Handle(operationContext, claims, RTCSignalRequest{
		RequestID: request.ID,
		Type:      request.Type, RoomID: scope.RoomID, SessionID: scope.SessionID,
		ParticipantID: claims.ParticipantID, Payload: request.Payload,
	})
	cancel()
	if err != nil {
		failure := rtc.FailureFor(err)
		if errors.Is(err, ErrRTCNotAvailable) {
			failure = rtc.FailureFor(rtc.ErrUnavailable)
		}
		client.protocolError(request.ID, failure.Code, failure.Message)
		return
	}
	if response.Type != rtcResponseTypes[request.Type] || response.Payload == nil {
		client.protocolError(request.ID, "internal_error", "The RTC media service returned an invalid response")
		return
	}
	client.response(request.ID, response.Type, response.Payload)
}

func (handler *Handler) disconnect(client *client, joined *joinedSession, claims auth.Claims) {
	handler.registry.leave(claims.RoomID, client)
	handler.registry.releaseSession(joined.session.ID, client)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if client.isRevoked() || handler.shutdown.Err() != nil || !time.Now().Before(claims.ExpiresAt.Time) {
		handler.finalizeSession(ctx, claims.RoomID, joined)
		return
	}
	if _, err := handler.sessionStore.Disconnect(ctx, joined.participant.ID, joined.session.ID); err != nil {
		handler.finalizeSession(ctx, claims.RoomID, joined)
		return
	}
	handler.scheduleRecovery(claims.RoomID, joined)
}

func (handler *Handler) scheduleRecovery(roomID string, joined *joinedSession) {
	cancelRecovery := make(chan struct{})
	handler.recoveryMu.Lock()
	if existing := handler.recoveries[joined.session.ID]; existing != nil {
		close(existing)
	}
	handler.recoveries[joined.session.ID] = cancelRecovery
	if handler.recoveryRooms == nil {
		handler.recoveryRooms = make(map[string]string)
	}
	handler.recoveryRooms[joined.session.ID] = roomID
	handler.recoveryMu.Unlock()

	handler.wg.Add(1)
	go func() {
		defer handler.wg.Done()
		timer := time.NewTimer(handler.recoveryTimeout)
		defer timer.Stop()
		select {
		case <-cancelRecovery:
			return
		case <-handler.shutdown.Done():
			return
		case <-timer.C:
		}
		handler.recoveryMu.Lock()
		if handler.recoveries[joined.session.ID] != cancelRecovery {
			handler.recoveryMu.Unlock()
			return
		}
		delete(handler.recoveries, joined.session.ID)
		delete(handler.recoveryRooms, joined.session.ID)
		handler.recoveryMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		leftAt, err := handler.sessionStore.Expire(ctx, roomID, joined.participant.ID, joined.session.ID)
		if err == nil {
			if handler.participantMedia != nil || handler.rtcService != nil {
				if cleanupErr := handler.removeSessionMedia(ctx, roomID, joined.participant.ID, joined.session.ID); cleanupErr != nil {
					slog.Warn("participant media cleanup failed", "error", cleanupErr, "participantId", joined.participant.ID, "roomId", roomID)
				}
			}
			handler.registry.broadcast(roomID, nil, event("participant.left", map[string]any{
				"roomId": roomID, "participantId": joined.participant.ID,
				"sessionId": joined.session.ID, "leftAt": leftAt,
			}))
		}
	}()
}

func (handler *Handler) cancelRecovery(sessionID string) {
	handler.recoveryMu.Lock()
	cancelRecovery := handler.recoveries[sessionID]
	delete(handler.recoveries, sessionID)
	delete(handler.recoveryRooms, sessionID)
	handler.recoveryMu.Unlock()
	if cancelRecovery != nil {
		close(cancelRecovery)
	}
}

func (handler *Handler) removeSessionMedia(ctx context.Context, roomID, participantID, sessionID string) error {
	if runtime, ok := handler.rtcService.(RTCSessionLifecycle); ok {
		return runtime.RemoveSession(ctx, roomID, participantID, sessionID)
	}
	if handler.participantMedia != nil {
		return handler.participantMedia.RemoveParticipant(ctx, roomID, participantID)
	}
	return nil
}

func (handler *Handler) finalizeSession(ctx context.Context, roomID string, joined *joinedSession) {
	leftAt, err := handler.sessionStore.Leave(ctx, roomID, joined.participant.ID, joined.session.ID)
	if err == nil {
		if handler.participantMedia != nil || handler.rtcService != nil {
			if cleanupErr := handler.removeSessionMedia(ctx, roomID, joined.participant.ID, joined.session.ID); cleanupErr != nil {
				slog.Warn("participant media cleanup failed", "error", cleanupErr, "participantId", joined.participant.ID, "roomId", roomID)
			}
		}
		handler.registry.broadcast(roomID, nil, event("participant.left", map[string]any{
			"roomId": roomID, "participantId": joined.participant.ID,
			"sessionId": joined.session.ID, "leftAt": leftAt,
		}))
	}
}

type incoming struct {
	data []byte
	err  error
}

func readPump(ctx context.Context, connection *websocket.Conn, result chan<- incoming) {
	for {
		messageType, data, err := connection.ReadMessage()
		message := incoming{data: data, err: err}
		if messageType != websocket.TextMessage && err == nil {
			message = incoming{err: errors.New("binary messages are unsupported")}
		}
		select {
		case result <- message:
		case <-ctx.Done():
			return
		}
		if message.err != nil {
			return
		}
	}
}

type requestEnvelope struct {
	Version int             `json:"v"`
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}
type joinPayload struct {
	RoomID           string `json:"roomId"`
	ParticipantToken string `json:"participantToken"`
}
type leavePayload struct {
	RoomID        string `json:"roomId"`
	ParticipantID string `json:"participantId"`
	SessionID     string `json:"sessionId"`
}
type resumePayload struct {
	RoomID      string `json:"roomId"`
	SessionID   string `json:"sessionId"`
	ResumeToken string `json:"resumeToken"`
}
type heartbeatPayload struct {
	Nonce string `json:"nonce"`
}

type usageSample struct {
	id       string
	incoming int64
	outgoing int64
}

type client struct {
	rateID         string
	outbound       chan outboundMessage
	outboundBytes  int
	queuedBytes    int
	writerStop     chan struct{}
	writerStopOnce sync.Once
	writerDone     chan struct{}
	operationMu    sync.Mutex
	revoked        bool
	rtcSessionID   string
	rtcCursor      uint64
	rtcReady       bool
	usageMu        sync.Mutex
	pendingUsage   *usageSample
	connection     *websocket.Conn
	writeTimeout   time.Duration
	mu             sync.Mutex
	messagesIn     int64
	messagesOut    int64
	recordedIn     int64
	recordedOut    int64
}

func (client *client) write(value any) error {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.writeLocked(value)
}

func (client *client) writeLocked(value any) error {
	if client.revoked {
		return session.ErrSessionNotResumable
	}
	if client.outbound != nil {
		return client.enqueueLocked(value, 0, "")
	}
	_ = client.connection.SetWriteDeadline(time.Now().Add(client.writeTimeout))
	err := client.connection.WriteJSON(value)
	if err == nil {
		client.messagesOut++
	}
	return err
}
func (client *client) recordMessageReceived() {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.messagesIn++
}
func (client *client) drainUsage() (int64, int64) {
	client.mu.Lock()
	defer client.mu.Unlock()
	messagesIn := client.messagesIn - client.recordedIn
	messagesOut := client.messagesOut - client.recordedOut
	client.recordedIn = client.messagesIn
	client.recordedOut = client.messagesOut
	return messagesIn, messagesOut
}
func (client *client) control(kind int, data []byte) error {
	return client.connection.WriteControl(kind, data, time.Now().Add(client.writeTimeout))
}
func (client *client) close(code int, reason string) {
	if client.outbound != nil {
		client.mu.Lock()
		select {
		case client.outbound <- outboundMessage{closeCode: code, reason: reason}:
		default:
			_ = client.connection.Close()
		}
		client.mu.Unlock()
		timer := time.NewTimer(client.writeTimeout)
		defer timer.Stop()
		select {
		case <-client.writerDone:
		case <-timer.C:
			_ = client.connection.Close()
		}
		return
	}
	_ = client.control(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason))
}
func (client *client) response(requestID, kind string, payload any) {
	_ = client.write(map[string]any{"v": 1, "id": newID("msg"), "requestId": requestID, "sentAt": time.Now().UTC(), "type": kind, "payload": payload})
}
func (client *client) protocolError(requestID, code, message string) {
	var value any = requestID
	if requestID == "" {
		value = nil
	}
	_ = client.write(map[string]any{"v": 1, "id": newID("msg"), "requestId": value, "sentAt": time.Now().UTC(), "type": "protocol.error", "payload": map[string]any{"code": code, "message": message, "retryable": code == "rate_limited", "details": map[string]any{}}})
}

type registry struct {
	mu          sync.RWMutex
	connections map[*client]struct{}
	rooms       map[string]map[*client]struct{}
	sessions    map[string]*client
}

func newRegistry() *registry {
	return &registry{
		connections: make(map[*client]struct{}), rooms: make(map[string]map[*client]struct{}),
		sessions: make(map[string]*client),
	}
}
func (r *registry) add(c *client) { r.mu.Lock(); defer r.mu.Unlock(); r.connections[c] = struct{}{} }
func (r *registry) remove(c *client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.connections, c)
	for roomID, clients := range r.rooms {
		delete(clients, c)
		if len(clients) == 0 {
			delete(r.rooms, roomID)
		}
	}
	for sessionID, owner := range r.sessions {
		if owner == c {
			delete(r.sessions, sessionID)
		}
	}
}

func (r *registry) claimSession(sessionID string, c *client) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if owner := r.sessions[sessionID]; owner != nil && owner != c {
		return false
	}
	r.sessions[sessionID] = c
	return true
}

func (r *registry) releaseSession(sessionID string, c *client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sessions[sessionID] == c {
		delete(r.sessions, sessionID)
	}
}
func (r *registry) join(roomID string, c *client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.rooms[roomID] == nil {
		r.rooms[roomID] = make(map[*client]struct{})
	}
	r.rooms[roomID][c] = struct{}{}
}
func (r *registry) leave(roomID string, c *client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.rooms[roomID], c)
}
func (r *registry) len() int { r.mu.RLock(); defer r.mu.RUnlock(); return len(r.connections) }
func (r *registry) broadcast(roomID string, except *client, message any) {
	r.mu.RLock()
	clients := make([]*client, 0, len(r.rooms[roomID]))
	for c := range r.rooms[roomID] {
		if c != except {
			clients = append(clients, c)
		}
	}
	r.mu.RUnlock()
	for _, c := range clients {
		_ = c.write(message)
	}
}

func (handler *Handler) PublishQualityEvent(roomID string, eventType string, payload any) {
	handler.registry.broadcast(roomID, nil, event(eventType, payload))
}

func (r *registry) roomClients(roomID string) []*client {
	r.mu.RLock()
	defer r.mu.RUnlock()
	clients := make([]*client, 0, len(r.rooms[roomID]))
	for client := range r.rooms[roomID] {
		clients = append(clients, client)
	}
	return clients
}

func event(kind string, payload any) map[string]any {
	return map[string]any{"v": 1, "id": newID("msg"), "sentAt": time.Now().UTC(), "type": kind, "payload": payload}
}
func newID(prefix string) string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(bytes)
}
func sessionErrorCode(err error) string {
	if errors.Is(err, session.ErrRoomNotJoinable) {
		return "not_found"
	}
	if errors.Is(err, session.ErrRoomFull) || errors.Is(err, session.ErrParticipantConflict) ||
		errors.Is(err, session.ErrSessionNotResumable) {
		return "conflict"
	}
	return "internal_error"
}
func sessionErrorMessage(err error) string {
	if errors.Is(err, session.ErrRoomNotJoinable) {
		return "The room is not available"
	}
	if errors.Is(err, session.ErrRoomFull) {
		return "The room is full"
	}
	if errors.Is(err, session.ErrParticipantConflict) {
		return "The participant has already joined"
	}
	if errors.Is(err, session.ErrSessionNotResumable) {
		return "The participant session cannot be resumed"
	}
	return "The room session could not be created"
}
func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
func writeHTTPError(response http.ResponseWriter, status int, code, description string) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]string{"code": code, "description": description})
}
