package main

import (
	"context"
	"log"
	"log/slog"
	"os"

	llmv1 "urban/gen/llm/v1"
	"urban/microservices/llm/internal/ollama"
	"urban/pkg/env"
	"urban/pkg/grpcserv"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type llmServer struct {
	llmv1.UnimplementedLLMServiceServer
	client *ollama.Client
	model  string
}

func toOllama(msgs []*llmv1.ChatMessage) []ollama.Message {
	out := make([]ollama.Message, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, ollama.Message{Role: m.GetRole(), Content: m.GetContent()})
	}
	return out
}

func (s *llmServer) Complete(ctx context.Context, req *llmv1.CompleteRequest) (*llmv1.CompleteResponse, error) {
	if len(req.GetMessages()) == 0 {
		return nil, status.Error(codes.InvalidArgument, "messages required")
	}
	text, err := s.client.Complete(ctx, firstNonEmpty(req.GetModel(), s.model), toOllama(req.GetMessages()))
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "ollama: %v", err)
	}
	return &llmv1.CompleteResponse{Text: text}, nil
}

func (s *llmServer) CompleteStream(req *llmv1.CompleteRequest, stream grpc.ServerStreamingServer[llmv1.Token]) error {
	if len(req.GetMessages()) == 0 {
		return status.Error(codes.InvalidArgument, "messages required")
	}
	ctx := stream.Context()
	err := s.client.Stream(ctx, firstNonEmpty(req.GetModel(), s.model), toOllama(req.GetMessages()), func(tok string, done bool) error {
		return stream.Send(&llmv1.Token{Text: tok, Done: done})
	})
	if err != nil {
		return status.Errorf(codes.Unavailable, "ollama: %v", err)
	}
	return nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	addr := env.String("LLM_GRPC_ADDR", ":50052")
	ollamaURL := env.String("OLLAMA_URL", "http://127.0.0.1:11434")
	model := env.String("OLLAMA_MODEL", "llama3.2:3b")
	timeouts := ollama.Timeouts{
		Overall:    env.Duration("OLLAMA_TIMEOUT", ollama.DefaultTimeout),
		Connect:    env.Duration("OLLAMA_CONNECT_TIMEOUT", ollama.DefaultConnectTimeout),
		FirstToken: env.Duration("OLLAMA_FIRST_TOKEN_TIMEOUT", ollama.DefaultFirstTokenTimeout),
	}
	generation := ollama.Generation{
		NumPredict: env.Int("OLLAMA_NUM_PREDICT", ollama.DefaultNumPredict),
		KeepAlive:  env.String("OLLAMA_KEEP_ALIVE", ollama.DefaultKeepAlive),
	}

	slog.Info("llm-svc starting",
		"ollama", ollamaURL,
		"model", model,
		"timeout", timeouts.Overall.String(),
		"connect_timeout", timeouts.Connect.String(),
		"first_token_timeout", timeouts.FirstToken.String(),
		"num_predict", generation.NumPredict,
		"keep_alive", generation.KeepAlive,
	)

	if err := grpcserv.Serve(addr, "llm-svc", func(gs *grpc.Server) {
		llmv1.RegisterLLMServiceServer(gs, &llmServer{
			client: ollama.NewWithConfig(ollamaURL, model, ollama.Config{
				Timeouts:   timeouts,
				Generation: generation,
			}),
			model: model,
		})
	}); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
