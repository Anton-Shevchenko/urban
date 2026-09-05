package gatewayhttp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	hexv1 "urban/gen/hex/v1"
	llmv1 "urban/gen/llm/v1"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func chatBody(t *testing.T) string {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"city_slug": "fixture",
		"h3":        "abc",
		"message":   "Wie ist der Score?",
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func postChat(t *testing.T, srv *Server, handler http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat", strings.NewReader(chatBody(t)))
	req.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(rr, req)
	return rr
}

type fakeHex struct {
	hex *hexv1.Hex
	err error
}

func (f fakeHex) GetHex(context.Context, *hexv1.GetHexRequest) (*hexv1.Hex, error) {
	return f.hex, f.err
}

type fakeStream struct {
	toks []*llmv1.Token
	i    int
}

func (s *fakeStream) Recv() (*llmv1.Token, error) {
	if s.i >= len(s.toks) {
		return nil, io.EOF
	}
	t := s.toks[s.i]
	s.i++
	return t, nil
}

// fakeLLM hands out a fresh stream per call so a test can chat more than once.
type fakeLLM struct {
	toks []*llmv1.Token
	err  error
}

func (f fakeLLM) CompleteStream(context.Context, *llmv1.CompleteRequest) (LLMStream, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &fakeStream{toks: f.toks}, nil
}

type fakeProbe struct {
	name string
	err  error
}

func (p fakeProbe) Name() string                { return p.name }
func (p fakeProbe) Check(context.Context) error { return p.err }

func TestHealthReportsServingBackends(t *testing.T) {
	srv := &Server{
		Hex:    fakeHex{},
		LLM:    fakeLLM{},
		Probes: []BackendProbe{fakeProbe{name: "hex"}, fakeProbe{name: "llm"}},
	}
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/health", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}

	var body struct {
		OK       bool              `json:"ok"`
		Backends map[string]string `json:"backends"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Backends["hex"] != "serving" || body.Backends["llm"] != "serving" {
		t.Fatalf("body = %+v", body)
	}
}

// A static {"ok":true} was the old behaviour and hid dead backends.
func TestHealthFailsWhenBackendIsDown(t *testing.T) {
	srv := &Server{
		Hex: fakeHex{},
		LLM: fakeLLM{},
		Probes: []BackendProbe{
			fakeProbe{name: "hex"},
			fakeProbe{name: "llm", err: errors.New("connection refused")},
		},
	}
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/health", nil))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503; body %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "connection refused") {
		t.Fatalf("body should name the failure: %s", rr.Body.String())
	}
}

func TestGetHexNotFound(t *testing.T) {
	srv := &Server{Hex: fakeHex{err: status.Error(codes.NotFound, "missing")}, LLM: fakeLLM{}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/hexes/fixture/nope", nil)
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
}

func chatServer(cfg Config) *Server {
	living := 70.0
	return &Server{
		Hex:    fakeHex{hex: &hexv1.Hex{H3: "abc", CitySlug: "fixture", CityName: "X", LivingScore: &living}},
		LLM:    fakeLLM{toks: []*llmv1.Token{{Text: "Hallo"}, {Text: " Welt", Done: true}}},
		Config: cfg,
	}
}

func TestChatStreamsTokens(t *testing.T) {
	srv := chatServer(Config{})
	rr := postChat(t, srv, srv.Handler())
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	out := rr.Body.String()
	if !strings.Contains(out, `"token":"Hallo"`) || !strings.Contains(out, `"token":" Welt"`) {
		t.Fatalf("tokens missing: %s", out)
	}
	if !strings.Contains(out, "event: done") {
		t.Fatalf("done event missing: %s", out)
	}
	if !strings.Contains(out, `"prompt_version":"v2"`) {
		t.Fatalf("prompt version missing: %s", out)
	}
}

func TestChatIsRateLimitedPerIP(t *testing.T) {
	// Two tokens of burst, effectively no refill during the test.
	srv := chatServer(Config{ChatRatePerMinute: 0.0001, ChatBurst: 2})
	handler := srv.Handler()

	for attempt := 1; attempt <= 2; attempt++ {
		if rr := postChat(t, srv, handler); rr.Code != http.StatusOK {
			t.Fatalf("attempt %d: status %d, want 200", attempt, rr.Code)
		}
	}
	rr := postChat(t, srv, handler)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("third attempt: status %d, want 429", rr.Code)
	}
	if rr.Header().Get("Retry-After") == "" {
		t.Fatal("429 should carry Retry-After")
	}
	if !strings.Contains(rr.Body.String(), `"error"`) {
		t.Fatalf("429 body should be JSON: %s", rr.Body.String())
	}
}

func TestErrorsAreJSONWithRequestID(t *testing.T) {
	srv := &Server{Hex: fakeHex{err: status.Error(codes.NotFound, "missing")}, LLM: fakeLLM{}}
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/hexes/fixture/nope", nil))

	if got := rr.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("content type %q", got)
	}
	var body struct {
		Error     string `json:"error"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error != "missing" {
		t.Fatalf("error = %q", body.Error)
	}
	if body.RequestID == "" || body.RequestID != rr.Header().Get(RequestIDHeader) {
		t.Fatalf("request id %q vs header %q", body.RequestID, rr.Header().Get(RequestIDHeader))
	}
}

func TestRequestIDFromClientIsEchoed(t *testing.T) {
	srv := &Server{Hex: fakeHex{}, LLM: fakeLLM{}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	req.Header.Set(RequestIDHeader, "trace-me")
	srv.Handler().ServeHTTP(rr, req)
	if got := rr.Header().Get(RequestIDHeader); got != "trace-me" {
		t.Fatalf("request id = %q", got)
	}
}

func TestGRPCDeadlineBecomesGatewayTimeout(t *testing.T) {
	srv := &Server{
		Hex:    fakeHex{err: status.Error(codes.DeadlineExceeded, "too slow")},
		LLM:    fakeLLM{},
		Config: Config{HexTimeout: 10 * time.Millisecond},
	}
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/hexes/fixture/abc", nil))
	if rr.Code != http.StatusGatewayTimeout {
		t.Fatalf("status %d, want 504", rr.Code)
	}
}

func TestCORSOnlyAnswersAllowlistedOrigins(t *testing.T) {
	srv := &Server{
		Hex:    fakeHex{},
		LLM:    fakeLLM{},
		Config: Config{AllowedOrigins: []string{"https://wohnindex.example"}},
	}
	handler := srv.Handler()

	allowed := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	req.Header.Set("Origin", "https://wohnindex.example")
	handler.ServeHTTP(allowed, req)
	if got := allowed.Header().Get("Access-Control-Allow-Origin"); got != "https://wohnindex.example" {
		t.Fatalf("allowed origin header = %q", got)
	}

	// Reflecting any Origin was the old behaviour; an unknown site must get nothing.
	denied := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	handler.ServeHTTP(denied, req)
	if got := denied.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("denied origin got CORS header %q", got)
	}
	if !strings.Contains(denied.Header().Get("Vary"), "Origin") {
		t.Fatal("Vary: Origin must be set even when denied")
	}
}

func TestCORSPreflightIsRejectedForUnknownOrigin(t *testing.T) {
	srv := &Server{
		Hex:    fakeHex{},
		LLM:    fakeLLM{},
		Config: Config{AllowedOrigins: []string{"http://localhost:8080"}},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/v1/chat", nil)
	req.Header.Set("Origin", "https://evil.example")
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rr.Code)
	}
}

func TestChatRejectsIncompleteBody(t *testing.T) {
	srv := chatServer(Config{})
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat", strings.NewReader(`{"city_slug":"fixture"}`))
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "required") {
		t.Fatalf("body = %s", rr.Body.String())
	}
}
