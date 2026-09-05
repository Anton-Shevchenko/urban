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

//go:embed prompts/hex_qa.v2.txt
var systemPrompt string

// Version identifies the embedded system prompt so answers can be attributed.
const Version = "v2"

// System is the grounded hex-QA prompt currently in use.
var System = strings.TrimSpace(systemPrompt)

const maxHistory = 8

type Turn struct {
	Role    string
	Content string
}

func Build(hex *hexv1.Hex, userMessage string, history []Turn) []*llmv1.ChatMessage {
	facts := hexJSON(hex)
	msgs := []*llmv1.ChatMessage{
		{Role: "system", Content: System},
		{Role: "user", Content: "Hexagon facts (JSON):\n" + facts},
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
