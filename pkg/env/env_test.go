package env

import (
	"testing"
	"time"
)

func TestStringFallsBackOnEmpty(t *testing.T) {
	t.Setenv("URBAN_TEST_STR", "")
	if got := String("URBAN_TEST_STR", "fallback"); got != "fallback" {
		t.Fatalf("got %q, want fallback", got)
	}
	t.Setenv("URBAN_TEST_STR", "  value  ")
	if got := String("URBAN_TEST_STR", "fallback"); got != "value" {
		t.Fatalf("got %q, want value", got)
	}
}

func TestIntAndDuration(t *testing.T) {
	t.Setenv("URBAN_TEST_INT", "7")
	if got := Int("URBAN_TEST_INT", 1); got != 7 {
		t.Fatalf("got %d, want 7", got)
	}
	if got := Int("URBAN_TEST_MISSING", 3); got != 3 {
		t.Fatalf("got %d, want 3", got)
	}
	t.Setenv("URBAN_TEST_DUR", "250ms")
	if got := Duration("URBAN_TEST_DUR", time.Second); got != 250*time.Millisecond {
		t.Fatalf("got %s, want 250ms", got)
	}
}

func TestStringSliceTrimsAndDropsEmpty(t *testing.T) {
	t.Setenv("URBAN_TEST_LIST", "a, b ,,c,")
	got := StringSlice("URBAN_TEST_LIST", nil)
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestBool(t *testing.T) {
	t.Setenv("URBAN_TEST_BOOL", "true")
	if !Bool("URBAN_TEST_BOOL", false) {
		t.Fatal("want true")
	}
	if Bool("URBAN_TEST_BOOL_MISSING", false) {
		t.Fatal("want fallback false")
	}
}
