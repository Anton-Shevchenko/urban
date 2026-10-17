// Package hexstore serves compact hex fact sheets by (city slug, h3).
//
// Cities are loaded on first use and evicted least-recently-used, so memory is
// bounded by CacheSize rather than by how many cities the pipeline generated.
// The data directory is rescanned periodically, so a freshly generated city is
// picked up without restarting the service.
package hexstore

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"urban/gen/contract"
	hexv1 "urban/gen/hex/v1"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	// DefaultCacheSize holds a handful of cities: one export is a few MB of
	// compact protos, and users browse one city at a time.
	DefaultCacheSize = 4
	// DefaultRescanInterval bounds how long a newly generated city stays invisible.
	DefaultRescanInterval = 30 * time.Second

	geojsonName = "hexes.geojson"
	metaName    = "meta.json"
	scoresName  = "scores.json"
)

type Options struct {
	DataDir        string
	RentsDir       string
	CacheSize      int
	RescanInterval time.Duration
}

func (o Options) withDefaults() Options {
	if o.CacheSize <= 0 {
		o.CacheSize = DefaultCacheSize
	}
	if o.RescanInterval <= 0 {
		o.RescanInterval = DefaultRescanInterval
	}
	return o
}

type city struct {
	name  string
	hexes map[string]*hexv1.Hex
}

// entry is created before loading starts so concurrent requests for the same
// city wait on one parse instead of each doing their own.
type entry struct {
	ready chan struct{}
	city  *city
	err   error
}

type Store struct {
	opts Options

	mu        sync.Mutex
	loaded    map[string]*entry
	lru       []string // least-recently-used first
	available []string
	lastScan  time.Time
}

// New verifies the data directory and takes a first inventory. It does not
// parse any city: that happens on demand.
func New(opts Options) (*Store, error) {
	opts = opts.withDefaults()
	info, err := os.Stat(opts.DataDir)
	if err != nil {
		return nil, fmt.Errorf("data dir %s: %w", opts.DataDir, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("data dir %s is not a directory", opts.DataDir)
	}
	s := &Store{opts: opts, loaded: map[string]*entry{}}
	s.mu.Lock()
	s.rescanLocked()
	s.mu.Unlock()
	return s, nil
}

// AvailableCities reports how many city exports are on disk.
func (s *Store) AvailableCities() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maybeRescanLocked()
	return len(s.available)
}

// LoadedCities reports how many cities are currently held in memory.
func (s *Store) LoadedCities() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.loaded)
}

// WarmFirst loads one city so the first real request does not pay for a parse.
func (s *Store) WarmFirst(ctx context.Context) {
	s.mu.Lock()
	s.maybeRescanLocked()
	var slug string
	if len(s.available) > 0 {
		slug = s.available[0]
	}
	s.mu.Unlock()
	if slug == "" {
		return
	}
	if _, err := s.city(ctx, slug); err != nil {
		slog.Warn("warmup failed", "slug", slug, "err", err)
	}
}

// Get returns the fact sheet for one hex, or (nil, nil) when the city exists
// but the hex does not. A missing city or an unreadable export is an error.
func (s *Store) Get(ctx context.Context, citySlug, h3 string) (*hexv1.Hex, error) {
	c, err := s.city(ctx, citySlug)
	if err != nil {
		return nil, err
	}
	hex, ok := c.hexes[h3]
	if !ok {
		return nil, nil
	}
	return hex, nil
}

func (s *Store) city(ctx context.Context, slug string) (*city, error) {
	if err := ctx.Err(); err != nil {
		return nil, status.FromContextError(err).Err()
	}
	if slug == "" || strings.ContainsAny(slug, `/\`) || slug == ".." {
		return nil, status.Errorf(codes.InvalidArgument, "invalid city slug %q", slug)
	}

	e, mine := s.entryFor(slug)
	if e == nil {
		return nil, status.Errorf(codes.NotFound, "city %s not found", slug)
	}
	if mine {
		e.city, e.err = s.loadCity(slug)
		if e.err != nil {
			// Do not cache the failure: the export may still be mid-write.
			s.forget(slug)
		}
		close(e.ready)
	}

	select {
	case <-e.ready:
	case <-ctx.Done():
		return nil, status.FromContextError(ctx.Err()).Err()
	}
	if e.err != nil {
		return nil, status.Errorf(codes.Internal, "load city %s: %v", slug, e.err)
	}
	return e.city, nil
}

// entryFor returns the cache entry for slug and whether the caller owns loading
// it. A nil entry means the city is not on disk.
func (s *Store) entryFor(slug string) (*entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if e, ok := s.loaded[slug]; ok {
		s.touchLocked(slug)
		return e, false
	}

	if !s.availableLocked(slug) {
		// A city generated seconds ago may not be in the last inventory.
		s.rescanLocked()
		if !s.availableLocked(slug) {
			return nil, false
		}
	}

	e := &entry{ready: make(chan struct{})}
	s.loaded[slug] = e
	s.lru = append(s.lru, slug)
	s.evictLocked()
	return e, true
}

func (s *Store) forget(slug string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.loaded, slug)
	s.lru = slices.DeleteFunc(s.lru, func(v string) bool { return v == slug })
}

func (s *Store) touchLocked(slug string) {
	s.lru = slices.DeleteFunc(s.lru, func(v string) bool { return v == slug })
	s.lru = append(s.lru, slug)
}

func (s *Store) evictLocked() {
	for len(s.lru) > s.opts.CacheSize {
		oldest := s.lru[0]
		s.lru = s.lru[1:]
		delete(s.loaded, oldest)
		slog.Info("evicted city from cache", "slug", oldest, "cache_size", s.opts.CacheSize)
	}
}

func (s *Store) availableLocked(slug string) bool {
	return slices.Contains(s.available, slug)
}

func (s *Store) maybeRescanLocked() {
	if time.Since(s.lastScan) >= s.opts.RescanInterval {
		s.rescanLocked()
	}
}

func (s *Store) rescanLocked() {
	s.lastScan = time.Now()
	entries, err := os.ReadDir(s.opts.DataDir)
	if err != nil {
		slog.Warn("rescan failed", "dir", s.opts.DataDir, "err", err)
		return
	}
	found := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(s.opts.DataDir, e.Name(), geojsonName)); err != nil {
			continue
		}
		found = append(found, e.Name())
	}
	slices.Sort(found)
	s.available = found
}

// --- parsing ---------------------------------------------------------------

type geojsonFile struct {
	Meta     map[string]any   `json:"meta"`
	Features []geojsonFeature `json:"features"`
}

type geojsonFeature struct {
	Properties map[string]any `json:"properties"`
}

func (s *Store) loadCity(slug string) (*city, error) {
	started := time.Now()
	cityDir := filepath.Join(s.opts.DataDir, slug)
	raw, err := os.ReadFile(filepath.Join(cityDir, geojsonName))
	if err != nil {
		return nil, err
	}
	var fc geojsonFile
	if err := json.Unmarshal(raw, &fc); err != nil {
		return nil, err
	}
	name := cityName(slug, cityDir, fc.Meta)
	hexes := make(map[string]*hexv1.Hex, len(fc.Features))
	for _, f := range fc.Features {
		h3 := stringProp(f.Properties, "h3", "h3_index")
		if h3 == "" {
			continue
		}
		hexes[h3] = factSheet(slug, name, h3, f.Properties)
	}
	s.mergeRents(slug, hexes)
	slog.Info("loaded city",
		"slug", slug,
		"hexes", len(hexes),
		"bytes", len(raw),
		"took", time.Since(started).String(),
	)
	return &city{name: name, hexes: hexes}, nil
}

// mergeRents fills rent fields from the rents service sidecar when that file
// exists. A city whose rents service has not finished yet simply has no rent.
func (s *Store) mergeRents(slug string, hexes map[string]*hexv1.Hex) {
	if s.opts.RentsDir == "" {
		return
	}
	raw, err := os.ReadFile(filepath.Join(s.opts.RentsDir, slug, scoresName))
	if err != nil {
		return
	}
	var doc struct {
		Scores map[string]map[string]any `json:"scores"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return
	}
	for h3, row := range doc.Scores {
		hex, ok := hexes[h3]
		if !ok {
			continue
		}
		if v, ok := asFloat(row["rent_eur_m2"]); ok {
			hex.RentEurM2 = &v
		}
		if v, ok := asFloat(row["asking_rent_eur_m2"]); ok {
			hex.AskingRentEurM2 = &v
		}
		if v, ok := asFloat(row["sale_eur_m2"]); ok {
			hex.SaleEurM2 = &v
		}
		if src := stringProp(row, "rent_source"); src != "" {
			hex.RentSource = src
		}
		if asOf := stringProp(row, "rent_as_of"); asOf != "" {
			hex.RentAsOf = asOf
		}
		if src := stringProp(row, "asking_rent_source"); src != "" {
			hex.AskingRentSource = src
		}
		if src := stringProp(row, "sale_source"); src != "" {
			hex.SaleSource = src
		}
	}
}

func cityName(slug, cityDir string, meta map[string]any) string {
	if meta != nil {
		if n, ok := meta["name"].(string); ok && n != "" {
			return n
		}
	}
	raw, err := os.ReadFile(filepath.Join(cityDir, metaName))
	if err == nil {
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil {
			if n, ok := m["name"].(string); ok && n != "" {
				return n
			}
		}
	}
	return slug
}

// pillarKeys and walkMinuteKeys map fact-sheet labels to the hex property names
// declared in contracts/metrics.json. TestConsumedKeysMatchContract
// fails if these drift from the contract's go-hex-svc consumer list.
var (
	pillarKeys     = contract.HexPillarKeys
	walkMinuteKeys = contract.HexWalkMinuteKeys
	scalarKeys     = contract.HexScalarKeys
)

func factSheet(slug, name, h3 string, props map[string]any) *hexv1.Hex {
	h := &hexv1.Hex{
		H3:          h3,
		CitySlug:    slug,
		CityName:    name,
		Pillars:     make(map[string]float64, len(pillarKeys)),
		WalkMinutes: make(map[string]float64, len(walkMinuteKeys)),
	}
	if v, ok := asFloat(props["s_living"]); ok {
		h.LivingScore = &v
	}
	for label, key := range pillarKeys {
		if v, ok := asFloat(props[key]); ok {
			h.Pillars[label] = v
		}
	}
	for label, key := range walkMinuteKeys {
		if v, ok := asFloat(props[key]); ok {
			h.WalkMinutes[label] = v
		}
	}
	if v, ok := asFloat(props["rent_eur_m2"]); ok {
		h.RentEurM2 = &v
	}
	if v, ok := asFloat(props["asking_rent_eur_m2"]); ok {
		h.AskingRentEurM2 = &v
	}
	if v, ok := asFloat(props["sale_eur_m2"]); ok {
		h.SaleEurM2 = &v
	}
	h.RentSource = stringProp(props, "rent_source")
	h.RentAsOf = stringProp(props, "rent_as_of")
	h.AskingRentSource = stringProp(props, "asking_rent_source")
	h.SaleSource = stringProp(props, "sale_source")
	h.VoiClass = stringProp(props, "voi_class")
	h.VoiExplain = stringProp(props, "voi_explain")
	return h
}

// consumedKeys is the flattened set of contract properties this package reads.
func consumedKeys() []string {
	out := make([]string, 0, len(pillarKeys)+len(walkMinuteKeys)+len(scalarKeys))
	out = append(out, scalarKeys...)
	for _, key := range pillarKeys {
		out = append(out, key)
	}
	for _, key := range walkMinuteKeys {
		out = append(out, key)
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// ContractProperties is the consumer list this package must stay aligned with.
func ContractProperties() []string { return contract.HexServiceProperties }

func stringProp(props map[string]any, keys ...string) string {
	for _, k := range keys {
		v, ok := props[k]
		if !ok || v == nil {
			continue
		}
		switch t := v.(type) {
		case string:
			if s := strings.TrimSpace(t); s != "" && s != "null" {
				return s
			}
		case fmt.Stringer:
			return t.String()
		default:
			s := strings.TrimSpace(fmt.Sprint(t))
			if s != "" && s != "<nil>" {
				return s
			}
		}
	}
	return ""
}

func asFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}
