// Package env reads process configuration with typed fallbacks.
package env

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

// String returns the variable, or fallback when unset or empty.
func String(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// Int returns the variable parsed as an int. Unparseable values are a
// configuration bug, so they fail the process instead of silently defaulting.
func Int(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		log.Fatalf("env %s: %q is not an integer", key, raw)
	}
	return v
}

// Duration accepts Go duration syntax, e.g. "250ms", "2m".
func Duration(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := time.ParseDuration(raw)
	if err != nil {
		log.Fatalf("env %s: %q is not a duration", key, raw)
	}
	return v
}

// Bool accepts the forms strconv.ParseBool understands (1/0, true/false, yes/no is not included).
func Bool(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		log.Fatalf("env %s: %q is not a boolean", key, raw)
	}
	return v
}

// StringSlice splits a comma-separated list and drops empty entries.
func StringSlice(key string, fallback []string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
