// Package grpcserv removes the listen / health / signal / drain boilerplate
// that every gRPC microservice in this repo would otherwise copy.
package grpcserv

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

// DrainTimeout bounds GracefulStop so a stuck stream cannot block a redeploy.
const DrainTimeout = 10 * time.Second

// Serve registers the gRPC health service, serves on addr, and blocks until
// SIGINT/SIGTERM. register wires the service implementations.
//
// Health starts as SERVING: readiness of the data a service needs is checked
// before Serve is called, so reaching this point means the service is usable.
func Serve(addr string, name string, register func(*grpc.Server)) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}

	server := grpc.NewServer()
	register(server)

	healthSrv := health.NewServer()
	healthSrv.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(server, healthSrv)

	errs := make(chan error, 1)
	go func() {
		slog.Info("grpc listening", "service", name, "addr", addr)
		errs <- server.Serve(lis)
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}

	slog.Info("draining grpc", "service", name, "timeout", DrainTimeout)
	healthSrv.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)

	drained := make(chan struct{})
	go func() {
		server.GracefulStop()
		close(drained)
	}()
	select {
	case <-drained:
	case <-time.After(DrainTimeout):
		slog.Warn("drain timed out, forcing stop", "service", name)
		server.Stop()
	}
	return nil
}
