package chatprompt

import (
	"strings"
	"testing"

	hexv1 "urban/gen/hex/v1"
)

func TestBuildIncludesFactsOmitsEmpty(t *testing.T) {
	living := 72.5
	h := &hexv1.Hex{
		H3:          "891f8d732cbffff",
		CitySlug:    "fixture",
		CityName:    "Teststadt",
		LivingScore: &living,
		Pillars:     map[string]float64{"transit": 88},
		WalkMinutes: map[string]float64{"supermarket": 4},
	}
	msgs := Build(h, "Wie ist der ÖPNV?", nil)
	if len(msgs) < 2 {
		t.Fatalf("got %d messages", len(msgs))
	}
	if msgs[0].Role != "system" || !strings.Contains(msgs[0].Content, "Living Score") {
		t.Fatalf("system prompt: %q", msgs[0].Content)
	}
	facts := msgs[1].Content
	if !strings.HasPrefix(facts, "Hexagon facts (JSON):\n") {
		t.Fatalf("facts prefix: %s", facts)
	}
	if !strings.Contains(facts, "891f8d732cbffff") || !strings.Contains(facts, "transit") {
		t.Fatalf("facts missing fields: %s", facts)
	}
	if strings.Contains(facts, "voiClass") || strings.Contains(facts, "voi_class") {
		t.Fatalf("empty voi should be omitted: %s", facts)
	}
	last := msgs[len(msgs)-1]
	if last.Role != "user" || last.Content != "Wie ist der ÖPNV?" {
		t.Fatalf("last message %+v", last)
	}
}

func TestPromptVersionIsStamped(t *testing.T) {
	if Version != "v3" {
		t.Fatalf("Version = %q, want v3", Version)
	}
	if !strings.Contains(System, "Living Score") {
		t.Fatalf("system prompt missing grounding rules: %q", System)
	}
	if !strings.Contains(System, "Do not invent") {
		t.Fatalf("system prompt missing no-invention rule: %q", System)
	}
	if !strings.Contains(System, "walk_minutes of 0") {
		t.Fatalf("system prompt missing in-hex walk rule: %q", System)
	}
}

func TestBuildIncludesShortlist(t *testing.T) {
	focus := &hexv1.Hex{H3: "hex-a", CitySlug: "muenchen", CityName: "München"}
	peer := &hexv1.Hex{H3: "hex-b", CitySlug: "koeln", CityName: "Köln"}
	msgs := Build(focus, "Compare them", nil, peer)
	facts := msgs[1].Content
	if !strings.Contains(facts, "Shortlist hexagon facts (JSON array):") {
		t.Fatalf("missing shortlist block: %s", facts)
	}
	if !strings.Contains(facts, "hex-a") || !strings.Contains(facts, "hex-b") {
		t.Fatalf("facts missing both hexes: %s", facts)
	}
	if !strings.Contains(facts, "walk_minutes 0") {
		t.Fatalf("shortlist should explain walk_minutes 0: %s", facts)
	}
	if !strings.Contains(msgs[0].Content, "shortlist") {
		t.Fatalf("system prompt should mention shortlist: %q", msgs[0].Content)
	}
}

func TestBuildKeepsRecentHistory(t *testing.T) {
	h := &hexv1.Hex{H3: "abc", CitySlug: "x", CityName: "Y"}
	hist := []Turn{
		{Role: "user", Content: "q1"},
		{Role: "assistant", Content: "a1"},
		{Role: "user", Content: "q2"},
		{Role: "assistant", Content: "a2"},
	}
	msgs := Build(h, "q3", hist)
	joined := ""
	for _, m := range msgs {
		joined += m.Role + ":" + m.Content + "\n"
	}
	if !strings.Contains(joined, "q2") || !strings.Contains(joined, "q3") {
		t.Fatalf("history not applied:\n%s", joined)
	}
}
