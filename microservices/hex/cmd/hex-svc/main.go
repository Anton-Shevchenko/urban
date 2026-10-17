package main

import (
	"context"
	"log"
	"log/slog"
	"os"
	"time"

	hexv1 "urban/gen/hex/v1"
	"urban/microservices/hex/internal/hexstore"
	"urban/pkg/env"
	"urban/pkg/grpcserv"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type hexServer struct {
	hexv1.UnimplementedHexServiceServer
	store *hexstore.Store
}

func (s *hexServer) GetHex(ctx context.Context, req *hexv1.GetHexRequest) (*hexv1.Hex, error) {
	if req.GetCitySlug() == "" || req.GetH3() == "" {
		return nil, status.Error(codes.InvalidArgument, "city_slug and h3 are required")
	}
	h, err := s.store.Get(ctx, req.GetCitySlug(), req.GetH3())
	if err != nil {
		return nil, err
	}
	if h == nil {
		return nil, status.Errorf(codes.NotFound, "hex %s/%s not found", req.GetCitySlug(), req.GetH3())
	}
	return h, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	addr := env.String("HEX_GRPC_ADDR", ":50051")
	dataDir := env.String("HEX_DATA_DIR", "/data/cities")
	rentsDir := env.String("HEX_RENTS_DIR", "")
	cacheSize := env.Int("HEX_CACHE_CITIES", hexstore.DefaultCacheSize)
	rescan := env.Duration("HEX_RESCAN_INTERVAL", hexstore.DefaultRescanInterval)

	store, err := hexstore.New(hexstore.Options{
		DataDir:        dataDir,
		RentsDir:       rentsDir,
		CacheSize:      cacheSize,
		RescanInterval: rescan,
	})
	if err != nil {
		log.Fatalf("hexstore: %v", err)
	}
	slog.Info("hex-svc ready",
		"data_dir", dataDir,
		"cities_available", store.AvailableCities(),
		"cache_size", cacheSize,
		"rescan_interval", rescan.String(),
	)

	// Warm the first city so the initial chat request is not the one paying
	// for a multi-megabyte GeoJSON parse.
	warmCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	store.WarmFirst(warmCtx)
	cancel()

	if err := grpcserv.Serve(addr, "hex-svc", func(gs *grpc.Server) {
		hexv1.RegisterHexServiceServer(gs, &hexServer{store: store})
	}); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
