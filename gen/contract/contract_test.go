package contract

import (
	"slices"
	"testing"
)

func TestObjectiveWeightsSumToOne(t *testing.T) {
	var total float64
	for _, w := range ObjectiveWeights {
		total += w
	}
	if diff := total - 1.0; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("objective weights sum to %v, want 1", total)
	}
}

func TestRequiredPropertiesAreDeclared(t *testing.T) {
	for _, key := range RequiredHexProperties {
		if !slices.Contains(DeclaredHexProperties, key) {
			t.Errorf("required property %q is not declared", key)
		}
	}
}

// hex-svc may read pattern properties (dn_*), which are not listed individually
// in DeclaredHexProperties, so only explicit names are checked here.
func TestHexServicePropertiesAreKnown(t *testing.T) {
	for _, key := range HexServiceProperties {
		if slices.Contains(DeclaredHexProperties, key) {
			continue
		}
		if len(key) > 3 && key[:3] == "dn_" {
			continue
		}
		t.Errorf("hex-svc reads %q, which the schema neither declares nor pattern-matches", key)
	}
}

func TestVersionsArePopulated(t *testing.T) {
	if ScoreMethodVersion == "" {
		t.Fatal("ScoreMethodVersion is empty")
	}
	if PipelineVersion <= 0 {
		t.Fatalf("PipelineVersion = %d", PipelineVersion)
	}
}
