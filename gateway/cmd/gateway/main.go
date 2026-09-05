package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	hexv1 "urban/gen/hex/v1"
	llmv1 "urban/gen/llm/v1"
	"urban/gateway/internal/gatewayhttp"
	"urban/pkg/env"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

// shutdownGrace must exceed nothing in particular, but it should let an
// in-flight SSE turn finish its current token rather than cutting mid-stream.
const shutdownGrace = 15 * time.Second

type hexAdapter struct{ hexv1.HexServiceClient }

func (a hexAdapter) GetHex(ctx context.Context, in *hexv1.GetHexRequest) (*hexv1.Hex, error) {
	return a.HexServiceClient.GetHex(ctx, in)
}

type llmAdapter struct{ llmv1.LLMServiceClient }

func (a llmAdapter) CompleteStream(ctx context.Context, in *llmv1.CompleteRequest) (gatewayhttp.LLMStream, error) {
	return a.LLMServiceClient.CompleteStream(ctx, in)
}

// grpcProbe answers /v1/health from the backend's own gRPC health service, so
// the gateway cannot report healthy while hex or llm are down.
type grpcProbe struct {
	name   string
	client healthpb.HealthClient
}

func (p grpcProbe) Name() string { return p.name }

func (p grpcProbe) Check(ctx context.Context) error {
	resp, err := p.client.Check(ctx, &healthpb.HealthCheckRequest{})
	if err != nil {
		return err
	}
	if resp.GetStatus() != healthpb.HealthCheckResponse_SERVING {
		return fmt.Errorf("status %s", resp.GetStatus())
	}
	return nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	httpAddr := env.String("GATEWAY_HTTP_ADDR", ":8081")
	hexAddr := env.String("HEX_GRPC_TARGET", "127.0.0.1:50051")
	llmAddr := env.String("LLM_GRPC_TARGET", "127.0.0.1:50052")

	cfg := gatewayhttp.Config{
		AllowedOrigins:    env.StringSlice("GATEWAY_ALLOWED_ORIGINS", nil),
		ChatTimeout:       env.Duration("GATEWAY_CHAT_TIMEOUT", 2*time.Minute),
		HexTimeout:        env.Duration("GATEWAY_HEX_TIMEOUT", 5*time.Second),
		HealthTimeout:     env.Duration("GATEWAY_HEALTH_TIMEOUT", 2*time.Second),
		ChatRatePerMinute: float64(env.Int("GATEWAY_CHAT_RATE_PER_MINUTE", 20)),
		ChatBurst:         env.Int("GATEWAY_CHAT_BURST", 5),
		TrustForwardedFor: env.Bool("GATEWAY_TRUST_FORWARDED_FOR", false),
	}

	hexConn, err := grpc.NewClient(hexAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("hex dial: %v", err)
	}
	defer hexConn.Close()
	llmConn, err := grpc.NewClient(llmAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("llm dial: %v", err)
	}
	defer llmConn.Close()

	srv := &gatewayhttp.Server{
		Hex:    hexAdapter{hexv1.NewHexServiceClient(hexConn)},
		LLM:    llmAdapter{llmv1.NewLLMServiceClient(llmConn)},
		Config: cfg,
		Probes: []gatewayhttp.BackendProbe{
			grpcProbe{name: "hex", client: healthpb.NewHealthClient(hexConn)},
			grpcProbe{name: "llm", client: healthpb.NewHealthClient(llmConn)},
		},
	}

	httpSrv := &http.Server{
		Addr:              httpAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		// No WriteTimeout: it would kill long SSE chat streams. The per-request
		// ChatTimeout context bounds those instead.
	}

	go func() {
		slog.Info("gateway listening",
			"addr", httpAddr,
			"hex", hexAddr,
			"llm", llmAddr,
			"allowed_origins", cfg.AllowedOrigins,
			"chat_rate_per_minute", cfg.ChatRatePerMinute,
		)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down", "grace", shutdownGrace.String())
	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		slog.Warn("shutdown incomplete", "err", err)
	}
}
