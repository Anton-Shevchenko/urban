// Package chatprompt builds grounded LLM messages for hex Q&A.
package chatprompt

import (
	_ "embed"
	"encoding/json"
	"strings"

	hexv1 "urban/gen/hex/v1"
	llmv1 "urban/gen/llm/v1"

	"google.golang.org/protobuf/encoding/protojson"
)

//go:embed prompts/hex_qa.v3.txt
var systemPrompt string

// Version identifies the embedded system prompt so answers can be attributed.
const Version = "v3"

// System is the grounded hex-QA prompt currently in use.
var System = strings.TrimSpace(systemPrompt)

const maxHistory = 8

type Turn struct {
	Role    string
	Content string
}

func Build(hex *hexv1.Hex, userMessage string, history []Turn, peers ...*hexv1.Hex) []*llmv1.ChatMessage {
	msgs := []*llmv1.ChatMessage{
		{Role: "system", Content: System},
		{Role: "user", Content: factsUserContent(hex, peers)},
		{Role: "assistant", Content: "I have read the facts and will answer only from them."},
	}
	n := len(history)
	start := 0
	if n > maxHistory {
		start = n - maxHistory
	}
	for _, t := range history[start:] {
		role := strings.ToLower(strings.TrimSpace(t.Role))
		if role != "user" && role != "assistant" {
			continue
		}
		content := strings.TrimSpace(t.Content)
		if content == "" {
			continue
		}
		msgs = append(msgs, &llmv1.ChatMessage{Role: role, Content: content})
	}
	msgs = append(msgs, &llmv1.ChatMessage{Role: "user", Content: strings.TrimSpace(userMessage)})
	return msgs
}

func factsUserContent(focus *hexv1.Hex, peers []*hexv1.Hex) string {
	var b strings.Builder
	b.WriteString("Hexagon facts (JSON):\n")
	b.WriteString(hexJSON(focus))
	clean := make([]*hexv1.Hex, 0, len(peers))
	focusKey := hexKey(focus)
	seen := map[string]struct{}{}
	if focusKey != "" {
		seen[focusKey] = struct{}{}
	}
	for _, p := range peers {
		if p == nil {
			continue
		}
		key := hexKey(p)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		clean = append(clean, p)
	}
	if len(clean) == 0 {
		return b.String()
	}
	b.WriteString("\n\nCompare the focus hex with this shortlist. Say who is better on living_score, green, transit, quiet, and daily amenities. walk_minutes 0 = amenity inside the hex.\n")
	raw := make([]json.RawMessage, 0, len(clean))
	for _, p := range clean {
		raw = append(raw, json.RawMessage(hexJSON(p)))
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return b.String()
	}
	b.WriteString("\n\nShortlist hexagon facts (JSON array):\n")
	b.Write(encoded)
	return b.String()
}

func hexKey(hex *hexv1.Hex) string {
	if hex == nil {
		return ""
	}
	city := strings.TrimSpace(hex.GetCitySlug())
	h3 := strings.TrimSpace(hex.GetH3())
	if city == "" || h3 == "" {
		return ""
	}
	return city + "\x00" + h3
}

func hexJSON(hex *hexv1.Hex) string {
	if hex == nil {
		return "{}"
	}
	b, err := protojson.MarshalOptions{EmitUnpopulated: false}.Marshal(hex)
	if err != nil {
		fallback, _ := json.Marshal(map[string]string{"h3": hex.GetH3(), "city": hex.GetCityName()})
		return string(fallback)
	}
	return string(b)
}
