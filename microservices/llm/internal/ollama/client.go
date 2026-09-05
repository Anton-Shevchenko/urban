// Package ollama talks to a local Ollama HTTP API.
package ollama

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const (
	// DefaultTimeout is the overall stream budget (cold model load + answer).
	DefaultTimeout = 3 * time.Minute
	// DefaultConnectTimeout covers TCP/TLS only.
	DefaultConnectTimeout = 10 * time.Second
	// DefaultFirstTokenTimeout covers response headers + first body byte.
	DefaultFirstTokenTimeout = 45 * time.Second
	// DefaultNumPredict caps generated tokens so answers stay short.
	DefaultNumPredict = 192
	// DefaultKeepAlive keeps the model loaded between chat turns.
	DefaultKeepAlive   = "30m"
	maxConnectAttempts = 3
)

// Timeouts splits connect, first-token, and overall stream budgets.
type Timeouts struct {
	Overall    time.Duration
	Connect    time.Duration
	FirstToken time.Duration
}

func (t Timeouts) withDefaults() Timeouts {
	if t.Overall <= 0 {
		t.Overall = DefaultTimeout
	}
	if t.Connect <= 0 {
		t.Connect = DefaultConnectTimeout
	}
	if t.FirstToken <= 0 {
		t.FirstToken = DefaultFirstTokenTimeout
	}
	return t
}

// Generation is sent on every Ollama /api/chat call.
type Generation struct {
	// NumPredict is Ollama num_predict. 0 means DefaultNumPredict; -1 is unlimited.
	NumPredict int
	// KeepAlive is Ollama keep_alive, e.g. "30m". Empty means DefaultKeepAlive.
	KeepAlive string
}

func (g Generation) withDefaults() Generation {
	if g.NumPredict == 0 {
		g.NumPredict = DefaultNumPredict
	}
	if strings.TrimSpace(g.KeepAlive) == "" {
		g.KeepAlive = DefaultKeepAlive
	}
	return g
}

// Config is the full client setup: timeouts plus generation caps.
type Config struct {
	Timeouts   Timeouts
	Generation Generation
}

type Client struct {
	baseURL      string
	defaultModel string
	http         *http.Client
	timeouts     Timeouts
	generation   Generation
}

func New(baseURL, model string, timeout time.Duration) *Client {
	return NewWithConfig(baseURL, model, Config{Timeouts: Timeouts{Overall: timeout}})
}

func NewWithTimeouts(baseURL, model string, timeouts Timeouts) *Client {
	return NewWithConfig(baseURL, model, Config{Timeouts: timeouts})
}

func NewWithConfig(baseURL, model string, cfg Config) *Client {
	timeouts := cfg.Timeouts.withDefaults()
	generation := cfg.Generation.withDefaults()
	dialer := &net.Dialer{Timeout: timeouts.Connect}
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   timeouts.Connect,
		ResponseHeaderTimeout: timeouts.FirstToken,
		ForceAttemptHTTP2:     true,
	}
	return &Client{
		baseURL:      strings.TrimRight(baseURL, "/"),
		defaultModel: model,
		timeouts:     timeouts,
		generation:   generation,
		http:         &http.Client{Transport: transport},
	}
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatOptions struct {
	NumPredict int `json:"num_predict"`
}

type chatRequest struct {
	Model     string       `json:"model"`
	Messages  []Message    `json:"messages"`
	Stream    bool         `json:"stream"`
	KeepAlive string       `json:"keep_alive,omitempty"`
	Options   *chatOptions `json:"options,omitempty"`
}

type chatChunk struct {
	Message struct {
		Content string `json:"content"`
	} `json:"message"`
	Done  bool   `json:"done"`
	Error string `json:"error,omitempty"`
}

func (c *Client) Complete(ctx context.Context, model string, messages []Message) (string, error) {
	var b strings.Builder
	err := c.Stream(ctx, model, messages, func(tok string, done bool) error {
		b.WriteString(tok)
		return nil
	})
	return b.String(), err
}

func (c *Client) Stream(ctx context.Context, model string, messages []Message, emit func(token string, done bool) error) error {
	if model == "" {
		model = c.defaultModel
	}
	req := chatRequest{
		Model:     model,
		Messages:  messages,
		Stream:    true,
		KeepAlive: c.generation.KeepAlive,
	}
	if c.generation.NumPredict != 0 {
		req.Options = &chatOptions{NumPredict: c.generation.NumPredict}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, c.timeouts.Overall)
	defer cancel()

	resp, err := c.doWithConnectRetry(ctx, body)
	if err != nil {
		return fmt.Errorf("ollama chat: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		slurp, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("ollama chat HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(slurp)))
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var chunk chatChunk
		if err := json.Unmarshal([]byte(line), &chunk); err != nil {
			return fmt.Errorf("ollama decode: %w", err)
		}
		if chunk.Error != "" {
			return fmt.Errorf("ollama: %s", chunk.Error)
		}
		if chunk.Message.Content != "" {
			if err := emit(chunk.Message.Content, false); err != nil {
				return err
			}
		}
		if chunk.Done {
			return emit("", true)
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return emit("", true)
}

func (c *Client) doWithConnectRetry(ctx context.Context, body []byte) (*http.Response, error) {
	var last error
	for attempt := 1; attempt <= maxConnectAttempts; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/chat", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := c.http.Do(req)
		if err == nil {
			return resp, nil
		}
		last = err
		if !isConnectError(err) || attempt == maxConnectAttempts {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt) * 200 * time.Millisecond):
		}
	}
	return nil, last
}

func isConnectError(err error) bool {
	if err == nil {
		return false
	}
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "dial" {
		return true
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "connect:") ||
		errors.Is(err, io.EOF) ||
		strings.Contains(msg, "eof")
}
