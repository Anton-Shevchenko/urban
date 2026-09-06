// Package gatewayhttp is the browser-facing HTTP API in front of hex and llm gRPC services.
package gatewayhttp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"urban/gateway/internal/chatprompt"
	hexv1 "urban/gen/hex/v1"
	llmv1 "urban/gen/llm/v1"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
)

// RequestIDHeader is echoed back and forwarded to the gRPC backends so one
// browser request can be traced across all three services.
const RequestIDHeader = "X-Request-Id"

const requestIDMetadataKey = "x-request-id"

// maxChatBody caps the JSON body; a hex chat turn is kilobytes, not megabytes.
const maxChatBody = 1 << 20

type HexClient interface {
	GetHex(ctx context.Context, in *hexv1.GetHexRequest) (*hexv1.Hex, error)
}

type LLMStream interface {
	Recv() (*llmv1.Token, error)
}

type LLMClient interface {
	CompleteStream(ctx context.Context, in *llmv1.CompleteRequest) (LLMStream, error)
}

// BackendProbe reports whether a downstream gRPC service is serving. Without
// probes /v1/health would report healthy while hex or llm are down.
type BackendProbe interface {
	Name() string
	Check(ctx context.Context) error
}

// Config holds the deployment-specific knobs. The zero value is usable in
// tests; main.go fills it from the environment.
type Config struct {
	// AllowedOrigins is an exact-match allowlist. Empty means same-origin only
	// (no CORS headers). "*" allows any origin — dev convenience only.
	AllowedOrigins []string
	// ChatTimeout bounds a whole chat turn, model load included.
	ChatTimeout time.Duration
	// HexTimeout bounds a single hex lookup.
	HexTimeout time.Duration
	// HealthTimeout bounds the downstream probes behind /v1/health.
	HealthTimeout time.Duration
	// ChatRatePerMinute and ChatBurst throttle POST /v1/chat per client IP.
	// The endpoint puts load on a local LLM, so it must not be free to abuse.
	ChatRatePerMinute float64
	ChatBurst         int
	// TrustForwardedFor reads the client IP from X-Forwarded-For. Only enable
	// behind a proxy that overwrites the header, otherwise clients can spoof it.
	TrustForwardedFor bool
}

func (c Config) withDefaults() Config {
	if c.ChatTimeout <= 0 {
		c.ChatTimeout = 2 * time.Minute
	}
	if c.HexTimeout <= 0 {
		c.HexTimeout = 5 * time.Second
	}
	if c.HealthTimeout <= 0 {
		c.HealthTimeout = 2 * time.Second
	}
	if c.ChatRatePerMinute <= 0 {
		c.ChatRatePerMinute = 20
	}
	if c.ChatBurst <= 0 {
		c.ChatBurst = 5
	}
	return c
}

type Server struct {
	Hex    HexClient
	LLM    LLMClient
	Probes []BackendProbe
	Config Config

	chatLimiter *ipRateLimiter
}

func (s *Server) Handler() http.Handler {
	cfg := s.Config.withDefaults()
	s.Config = cfg
	s.chatLimiter = newIPRateLimiter(cfg.ChatRatePerMinute/60, cfg.ChatBurst)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.health)
	mux.HandleFunc("GET /v1/hexes/{slug}/{h3}", s.getHex)
	mux.Handle("POST /v1/chat", s.rateLimit(http.HandlerFunc(s.chat)))

	return withRequestID(withLogging(withCORS(cfg.AllowedOrigins, mux)))
}

// --- handlers ---------------------------------------------------------------

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.Config.HealthTimeout)
	defer cancel()

	backends := make(map[string]string, len(s.Probes))
	ok := true
	for _, probe := range s.Probes {
		if err := probe.Check(ctx); err != nil {
			backends[probe.Name()] = "unavailable: " + err.Error()
			ok = false
			continue
		}
		backends[probe.Name()] = "serving"
	}

	code := http.StatusOK
	if !ok {
		code = http.StatusServiceUnavailable
	}
	writeJSON(w, code, map[string]any{"ok": ok, "backends": backends})
}

func (s *Server) getHex(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(r.PathValue("slug"))
	h3 := strings.TrimSpace(r.PathValue("h3"))
	if slug == "" || h3 == "" {
		writeError(w, r, http.StatusBadRequest, "slug and h3 are required")
		return
	}

	ctx, cancel := context.WithTimeout(outgoing(r), s.Config.HexTimeout)
	defer cancel()

	hexCell, err := s.Hex.GetHex(ctx, &hexv1.GetHexRequest{CitySlug: slug, H3: h3})
	if err != nil {
		writeGRPCError(w, r, err)
		return
	}
	body, err := protojson.MarshalOptions{EmitUnpopulated: false}.Marshal(hexCell)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "could not encode hex")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

type chatCompareRef struct {
	CitySlug string `json:"city_slug"`
	H3       string `json:"h3"`
}

type chatRequest struct {
	CitySlug string            `json:"city_slug"`
	H3       string            `json:"h3"`
	Message  string            `json:"message"`
	History  []chatprompt.Turn `json:"history"`
	Compare  []chatCompareRef  `json:"compare"`
}

func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxChatBody)).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid json")
		return
	}
	req.CitySlug = strings.TrimSpace(req.CitySlug)
	req.H3 = strings.TrimSpace(req.H3)
	req.Message = strings.TrimSpace(req.Message)
	if req.CitySlug == "" || req.H3 == "" || req.Message == "" {
		writeError(w, r, http.StatusBadRequest, "city_slug, h3 and message are required")
		return
	}

	ctx, cancel := context.WithTimeout(outgoing(r), s.Config.ChatTimeout)
	defer cancel()

	hexCell, err := s.Hex.GetHex(ctx, &hexv1.GetHexRequest{CitySlug: req.CitySlug, H3: req.H3})
	if err != nil {
		writeGRPCError(w, r, err)
		return
	}

	peers := s.loadCompareHexes(ctx, r, req.CitySlug, req.H3, req.Compare)
	msgs := chatprompt.Build(hexCell, req.Message, req.History, peers...)
	stream, err := s.LLM.CompleteStream(ctx, &llmv1.CompleteRequest{Messages: msgs})
	if err != nil {
		writeGRPCError(w, r, err)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	for {
		tok, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			writeSSEDone(w, flusher)
			return
		}
		if err != nil {
			logger(r).Error("chat stream failed", "err", err)
			payload, _ := json.Marshal(map[string]string{"error": err.Error()})
			fmt.Fprintf(w, "event: error\ndata: %s\n\n", payload)
			flusher.Flush()
			return
		}
		if tok.GetText() != "" {
			payload, _ := json.Marshal(map[string]string{"token": tok.GetText()})
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
		}
		if tok.GetDone() {
			writeSSEDone(w, flusher)
			return
		}
	}
}

const maxComparePeers = 5

func (s *Server) loadCompareHexes(
	ctx context.Context,
	r *http.Request,
	focusCity, focusH3 string,
	refs []chatCompareRef,
) []*hexv1.Hex {
	focusKey := focusCity + "\x00" + focusH3
	seen := map[string]struct{}{focusKey: {}}
	out := make([]*hexv1.Hex, 0, maxComparePeers)
	log := logger(r)
	for _, ref := range refs {
		if len(out) >= maxComparePeers {
			break
		}
		city := strings.TrimSpace(ref.CitySlug)
		h3 := strings.TrimSpace(ref.H3)
		if city == "" || h3 == "" {
			continue
		}
		key := city + "\x00" + h3
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		hexCell, err := s.Hex.GetHex(ctx, &hexv1.GetHexRequest{CitySlug: city, H3: h3})
		if err != nil {
			log.Info("compare hex skipped", "city_slug", city, "h3", h3, "err", err)
			continue
		}
		if hexCell == nil {
			continue
		}
		out = append(out, hexCell)
	}
	return out
}

func writeSSEDone(w http.ResponseWriter, flusher http.Flusher) {
	payload, _ := json.Marshal(map[string]string{"prompt_version": chatprompt.Version})
	fmt.Fprintf(w, "event: done\ndata: %s\n\n", payload)
	flusher.Flush()
}

// --- responses --------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError always answers JSON so the browser can render one consistent shape.
func writeError(w http.ResponseWriter, r *http.Request, code int, message string) {
	if id := requestIDFrom(r); id != "" {
		writeJSON(w, code, map[string]string{"error": message, "request_id": id})
		return
	}
	writeJSON(w, code, map[string]string{"error": message})
}

func writeGRPCError(w http.ResponseWriter, r *http.Request, err error) {
	st, ok := status.FromError(err)
	if !ok {
		writeError(w, r, http.StatusBadGateway, err.Error())
		return
	}
	code := http.StatusBadGateway
	switch st.Code() {
	case codes.NotFound:
		code = http.StatusNotFound
	case codes.InvalidArgument:
		code = http.StatusBadRequest
	case codes.DeadlineExceeded:
		code = http.StatusGatewayTimeout
	case codes.Canceled:
		// The client hung up; nothing useful to send.
		code = 499
	case codes.ResourceExhausted:
		code = http.StatusTooManyRequests
	case codes.Unavailable, codes.Internal, codes.Unknown:
		code = http.StatusBadGateway
	}
	writeError(w, r, code, st.Message())
}

// --- middleware -------------------------------------------------------------

type ctxKey int

const (
	ctxRequestID ctxKey = iota
	ctxLogger
)

func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.Header.Get(RequestIDHeader))
		if id == "" {
			id = newRequestID()
		}
		w.Header().Set(RequestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxRequestID, id)))
	})
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log := slog.With(
			"request_id", requestIDFrom(r),
			"method", r.Method,
			"path", r.URL.Path,
		)
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		started := time.Now()
		next.ServeHTTP(rec, r.WithContext(context.WithValue(r.Context(), ctxLogger, log)))
		log.Info("request",
			"status", rec.status,
			"bytes", rec.written,
			"took_ms", time.Since(started).Milliseconds(),
		)
	})
}

// withCORS answers only for allowlisted origins. Reflecting any Origin would
// let any site call the chat endpoint with the visitor's browser.
func withCORS(allowed []string, next http.Handler) http.Handler {
	allowAny := false
	set := make(map[string]struct{}, len(allowed))
	for _, origin := range allowed {
		if origin == "*" {
			allowAny = true
			continue
		}
		set[strings.TrimRight(origin, "/")] = struct{}{}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimRight(strings.TrimSpace(r.Header.Get("Origin")), "/")
		permitted := origin != "" && allowAny
		if origin != "" && !permitted {
			_, permitted = set[origin]
		}

		if permitted {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, "+RequestIDHeader)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		// Vary unconditionally: the response differs by Origin even when denied.
		w.Header().Add("Vary", "Origin")

		if r.Method == http.MethodOptions {
			if origin != "" && !permitted {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r, s.Config.TrustForwardedFor)
		if !s.chatLimiter.allow(ip) {
			logger(r).Warn("chat rate limited", "ip", ip)
			w.Header().Set("Retry-After", "60")
			writeError(w, r, http.StatusTooManyRequests, "too many chat requests, try again shortly")
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status  int
	written int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	n, err := r.ResponseWriter.Write(b)
	r.written += n
	return n, err
}

// Flush keeps SSE working through the logging wrapper.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// --- helpers ----------------------------------------------------------------

func newRequestID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}

func requestIDFrom(r *http.Request) string {
	if id, ok := r.Context().Value(ctxRequestID).(string); ok {
		return id
	}
	return ""
}

func logger(r *http.Request) *slog.Logger {
	if log, ok := r.Context().Value(ctxLogger).(*slog.Logger); ok {
		return log
	}
	return slog.Default()
}

// outgoing attaches the request ID to gRPC metadata so hex-svc and llm-svc log
// the same identifier as the gateway.
func outgoing(r *http.Request) context.Context {
	id := requestIDFrom(r)
	if id == "" {
		return r.Context()
	}
	return metadata.AppendToOutgoingContext(r.Context(), requestIDMetadataKey, id)
}

func clientIP(r *http.Request, trustForwarded bool) string {
	if trustForwarded {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			if first, _, ok := strings.Cut(fwd, ","); ok {
				return strings.TrimSpace(first)
			}
			return strings.TrimSpace(fwd)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
