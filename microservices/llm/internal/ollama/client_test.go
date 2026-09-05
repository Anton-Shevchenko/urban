package ollama

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newStubServer(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New(srv.URL, "test-model", 5*time.Second)
}

func TestStreamEmitsTokensThenDone(t *testing.T) {
	client := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = w.Write([]byte(
			`{"message":{"content":"Hallo"}}` + "\n" +
				`{"message":{"content":" Welt"}}` + "\n" +
				`{"done":true}` + "\n",
		))
	})

	var tokens []string
	doneSeen := false
	err := client.Stream(context.Background(), "", nil, func(tok string, done bool) error {
		if done {
			doneSeen = true
			return nil
		}
		tokens = append(tokens, tok)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(tokens, ""); got != "Hallo Welt" {
		t.Fatalf("tokens = %q", got)
	}
	if !doneSeen {
		t.Fatal("expected a final done callback")
	}
}

func TestCompleteConcatenatesStream(t *testing.T) {
	client := newStubServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"message":{"content":"a"}}` + "\n" + `{"message":{"content":"b"}}` + "\n" + `{"done":true}` + "\n"))
	})
	text, err := client.Complete(context.Background(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if text != "ab" {
		t.Fatalf("text = %q", text)
	}
}

func TestStreamSurfacesHTTPError(t *testing.T) {
	client := newStubServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`model "test-model" not found`))
	})
	err := client.Stream(context.Background(), "", nil, func(string, bool) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("err = %v, want an HTTP 404 error", err)
	}
}

func TestStreamSurfacesOllamaChunkError(t *testing.T) {
	client := newStubServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"error":"out of memory"}` + "\n"))
	})
	err := client.Stream(context.Background(), "", nil, func(string, bool) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "out of memory") {
		t.Fatalf("err = %v, want the chunk error", err)
	}
}

func TestStreamStopsOnCancelledContext(t *testing.T) {
	client := newStubServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"done":true}` + "\n"))
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := client.Stream(ctx, "", nil, func(string, bool) error { return nil }); err == nil {
		t.Fatal("expected an error for a cancelled context")
	}
}

func TestNewFallsBackToDefaultTimeout(t *testing.T) {
	c := New("http://example.invalid/", "m", 0)
	if c.timeouts.Overall != DefaultTimeout {
		t.Fatalf("timeout = %s, want %s", c.timeouts.Overall, DefaultTimeout)
	}
	if c.timeouts.Connect != DefaultConnectTimeout {
		t.Fatalf("connect = %s", c.timeouts.Connect)
	}
	if c.timeouts.FirstToken != DefaultFirstTokenTimeout {
		t.Fatalf("first token = %s", c.timeouts.FirstToken)
	}
	if c.generation.NumPredict != DefaultNumPredict {
		t.Fatalf("num_predict = %d", c.generation.NumPredict)
	}
	if c.generation.KeepAlive != DefaultKeepAlive {
		t.Fatalf("keep_alive = %q", c.generation.KeepAlive)
	}
	if c.baseURL != "http://example.invalid" {
		t.Fatalf("baseURL = %q, want trailing slash trimmed", c.baseURL)
	}
}

func TestStreamSendsGenerationOptions(t *testing.T) {
	client := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			KeepAlive string `json:"keep_alive"`
			Options   struct {
				NumPredict int `json:"num_predict"`
			} `json:"options"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		if req.KeepAlive != DefaultKeepAlive {
			t.Fatalf("keep_alive = %q, want %q", req.KeepAlive, DefaultKeepAlive)
		}
		if req.Options.NumPredict != DefaultNumPredict {
			t.Fatalf("num_predict = %d, want %d", req.Options.NumPredict, DefaultNumPredict)
		}
		_, _ = w.Write([]byte(`{"done":true}` + "\n"))
	})
	if err := client.Stream(context.Background(), "", nil, func(string, bool) error { return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestStreamUnlimitedOmitsNumPredictZeroSentinel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Options *struct {
				NumPredict int `json:"num_predict"`
			} `json:"options"`
			KeepAlive string `json:"keep_alive"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		if req.Options == nil || req.Options.NumPredict != -1 {
			t.Fatalf("options = %+v, want num_predict -1", req.Options)
		}
		if req.KeepAlive != "-1" {
			t.Fatalf("keep_alive = %q, want -1", req.KeepAlive)
		}
		_, _ = w.Write([]byte(`{"done":true}` + "\n"))
	}))
	t.Cleanup(srv.Close)
	client := NewWithConfig(srv.URL, "test-model", Config{
		Timeouts:   Timeouts{Overall: 5 * time.Second},
		Generation: Generation{NumPredict: -1, KeepAlive: "-1"},
	})
	if err := client.Stream(context.Background(), "", nil, func(string, bool) error { return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestStreamRetriesConnectResetThenSucceeds(t *testing.T) {
	attempts := 0
	client := newStubServer(t, func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Fatal("hijack unsupported")
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				t.Fatal(err)
			}
			_ = conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = w.Write([]byte(`{"message":{"content":"ok"}}` + "\n" + `{"done":true}` + "\n"))
	})

	text, err := client.Complete(context.Background(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if text != "ok" {
		t.Fatalf("text = %q", text)
	}
	if attempts < 2 {
		t.Fatalf("attempts = %d, want a retry", attempts)
	}
}

func TestStreamFirstTokenTimeout(t *testing.T) {
	client := newClientWithTimeouts(t, Timeouts{
		Overall:    2 * time.Second,
		Connect:    time.Second,
		FirstToken: 80 * time.Millisecond,
	}, func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(400 * time.Millisecond)
		_, _ = w.Write([]byte(`{"done":true}` + "\n"))
	})
	err := client.Stream(context.Background(), "", nil, func(string, bool) error { return nil })
	if err == nil {
		t.Fatal("expected a first-token timeout")
	}
}

func TestStreamSlowBodyWithinOverallBudget(t *testing.T) {
	client := newClientWithTimeouts(t, Timeouts{
		Overall:    2 * time.Second,
		Connect:    time.Second,
		FirstToken: 200 * time.Millisecond,
	}, func(w http.ResponseWriter, _ *http.Request) {
		fl, _ := w.(http.Flusher)
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = w.Write([]byte(`{"message":{"content":"a"}}` + "\n"))
		if fl != nil {
			fl.Flush()
		}
		time.Sleep(120 * time.Millisecond)
		_, _ = w.Write([]byte(`{"message":{"content":"b"}}` + "\n" + `{"done":true}` + "\n"))
	})
	text, err := client.Complete(context.Background(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if text != "ab" {
		t.Fatalf("text = %q", text)
	}
}

func newClientWithTimeouts(t *testing.T, timeouts Timeouts, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return NewWithTimeouts(srv.URL, "test-model", timeouts)
}
