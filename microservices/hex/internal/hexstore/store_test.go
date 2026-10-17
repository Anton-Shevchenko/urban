package hexstore

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func newTestStore(t *testing.T, opts Options) *Store {
	t.Helper()
	if opts.DataDir == "" {
		opts.DataDir = "testdata"
	}
	s, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestGetMapsContractProperties(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	if got := s.AvailableCities(); got != 1 {
		t.Fatalf("available cities = %d, want 1", got)
	}

	h, err := s.Get(ctx, "fixture", "891f8d732cbffff")
	if err != nil {
		t.Fatal(err)
	}
	if h == nil {
		t.Fatal("expected hit")
	}
	if h.GetCityName() != "Teststadt" {
		t.Fatalf("city name %q", h.GetCityName())
	}
	if h.GetLivingScore() != 72.5 {
		t.Fatalf("living %v", h.GetLivingScore())
	}
	if h.Pillars["transit"] != 88 {
		t.Fatalf("transit pillar %v", h.Pillars["transit"])
	}
	if h.WalkMinutes["supermarket"] != 4 {
		t.Fatalf("supermarket minutes %v", h.WalkMinutes["supermarket"])
	}
	if h.GetRentEurM2() != 14.2 {
		t.Fatalf("rent %v", h.GetRentEurM2())
	}
	if h.RentSource != "Zensus 2022" || h.RentAsOf != "2026-08" {
		t.Fatalf("rent provenance %q %q", h.RentSource, h.RentAsOf)
	}
	if h.GetAskingRentEurM2() != 18.4 || h.AskingRentSource != "ImmoScout24" {
		t.Fatalf("asking rent %v %q", h.GetAskingRentEurM2(), h.AskingRentSource)
	}
	if h.GetSaleEurM2() != 5251 || h.SaleSource != "GREIX" {
		t.Fatalf("sale %v %q", h.GetSaleEurM2(), h.SaleSource)
	}
	if h.VoiClass != "hidden_gem" {
		t.Fatalf("voi class %q", h.VoiClass)
	}
}

func TestGetMissesAndErrors(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	h, err := s.Get(ctx, "fixture", "missing")
	if err != nil || h != nil {
		t.Fatalf("unknown hex: got (%v, %v), want (nil, nil)", h, err)
	}

	_, err = s.Get(ctx, "no-city", "891f8d732cbffff")
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown city: got %v, want NotFound", err)
	}

	_, err = s.Get(ctx, "../escape", "891f8d732cbffff")
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("path traversal: got %v, want InvalidArgument", err)
	}
}

func TestGetHonoursContextCancellation(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.Get(ctx, "fixture", "891f8d732cbffff"); status.Code(err) != codes.Canceled {
		t.Fatalf("got %v, want Canceled", err)
	}
}

func TestCitiesAreLoadedLazily(t *testing.T) {
	s := newTestStore(t, Options{})
	if got := s.LoadedCities(); got != 0 {
		t.Fatalf("loaded before first request = %d, want 0", got)
	}
	if _, err := s.Get(context.Background(), "fixture", "891f8d732cbffff"); err != nil {
		t.Fatal(err)
	}
	if got := s.LoadedCities(); got != 1 {
		t.Fatalf("loaded after first request = %d, want 1", got)
	}
}

func TestCacheEvictsLeastRecentlyUsed(t *testing.T) {
	dir := t.TempDir()
	for _, slug := range []string{"a", "b", "c"} {
		writeFixtureCity(t, dir, slug)
	}
	s := newTestStore(t, Options{DataDir: dir, CacheSize: 2})
	ctx := context.Background()

	for _, slug := range []string{"a", "b", "c"} {
		if _, err := s.Get(ctx, slug, "hex-"+slug); err != nil {
			t.Fatal(err)
		}
	}
	if got := s.LoadedCities(); got != 2 {
		t.Fatalf("cache holds %d cities, want 2", got)
	}
}

func TestNewCitiesAppearWithoutRestart(t *testing.T) {
	dir := t.TempDir()
	writeFixtureCity(t, dir, "a")
	s := newTestStore(t, Options{DataDir: dir, RescanInterval: time.Hour})
	ctx := context.Background()

	// "b" did not exist during the initial inventory.
	writeFixtureCity(t, dir, "b")
	if _, err := s.Get(ctx, "b", "hex-b"); err != nil {
		t.Fatalf("newly generated city not picked up: %v", err)
	}
}

func TestConcurrentGetLoadsCityOnce(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Get(ctx, "fixture", "891f8d732cbffff"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if got := s.LoadedCities(); got != 1 {
		t.Fatalf("loaded %d cities, want 1", got)
	}
}

// TestConsumedKeysMatchContract is the drift guard: adding a property to the
// fact sheet without declaring it in contracts/hex-properties.schema.json (or
// removing it from the contract) fails here instead of in production.
func TestConsumedKeysMatchContract(t *testing.T) {
	declared := slices.Clone(ContractProperties())
	slices.Sort(declared)
	consumed := consumedKeys()

	if !slices.Equal(consumed, declared) {
		t.Fatalf(
			"hex-svc consumed keys differ from contract x-consumers[go-hex-svc]\nconsumed: %v\ncontract: %v",
			consumed, declared,
		)
	}
}

func writeFixtureCity(t *testing.T, root, slug string) {
	t.Helper()
	dir := filepath.Join(root, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	doc := map[string]any{
		"type": "FeatureCollection",
		"meta": map[string]any{"name": slug, "slug": slug},
		"features": []any{
			map[string]any{
				"type":       "Feature",
				"properties": map[string]any{"h3": "hex-" + slug, "s_living": 50},
			},
		},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, geojsonName), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}
