.PHONY: help start stop clear-cache generate generate-all proto \
	test test-go test-py test-web lint contract-check proto-check ollama \
	старт стоп скинути-кеш генерувати генерувати-всі

COMPOSE ?= docker compose
export URBAN_ROOT := $(abspath .)
# Absolute so targets that change directory (test-py) still resolve it.
PYTHON  ?= $(URBAN_ROOT)/.venv/bin/python
export PYTHONPATH := $(URBAN_ROOT)/microservices/data
CITY    ?=

help:
	@echo "Targets:"
	@echo "  make start                    — API + frontend + Go chat stack (docker compose)"
	@echo "  make ollama                   — pull llama3.2:3b into native Ollama on the host"
	@echo "  make stop                     — зупинити контейнери"
	@echo "  make clear-cache              — скинути pipeline / Vite кеш і міста на карті"
	@echo "  make generate CITY=Hamburg    — згенерувати кеш для міста"
	@echo "  make generate-all             — перегенерувати всі міста з data/cities/"
	@echo "  make proto                    — regenerate Go gRPC stubs"
	@echo "  make test                     — run every test suite (go + python + web)"
	@echo "  make test-go                  — run Go microservice tests"
	@echo "  make test-py                  — run data-service pytest suite"
	@echo "  make test-web                 — run frontend typecheck + vitest"
	@echo "  make lint                     — lint Go, Python and frontend"
	@echo "  make contract-check           — fail when generated contract code is stale"
	@echo "  make proto-check              — fail when generated gRPC stubs are stale"
	@echo ""
	@echo "Аліаси: старт · стоп · скинути-кеш · генерувати · генерувати-всі"

start старт:
	$(COMPOSE) up --build -d --remove-orphans
	@echo "UI      → http://localhost:8080"
	@echo "API     → http://localhost:8000"
	@echo "Gateway → http://localhost:8081"
	@echo "Chat talks to native Ollama on :11434 (make ollama). First answer is faster after the model is loaded."

ollama:
	@command -v ollama >/dev/null || { echo "Install Ollama from https://ollama.com then re-run make ollama"; exit 1; }
	ollama pull llama3.2:3b

stop стоп:
	$(COMPOSE) down

clear-cache скинути-кеш:
	rm -rf microservices/data/data/cache/*
	rm -rf microservices/data/data/cities/*/cache
	rm -f microservices/data/data/cities/*/hexes.geojson \
		microservices/data/data/cities/*/cycleways.geojson
	rm -f microservices/data/data/wohnindex.db \
		microservices/data/data/wohnindex.db-wal \
		microservices/data/data/wohnindex.db-shm \
		microservices/data/data/*.db-journal
	rm -rf frontend/node_modules/.vite
	find . -type d -name __pycache__ -not -path './.venv/*' -exec rm -rf {} + 2>/dev/null || true
	@if ids=$$($(COMPOSE) ps -q api hex-svc 2>/dev/null) && [ -n "$$ids" ]; then \
		$(COMPOSE) restart api hex-svc; \
	fi
	@echo "Кеш і згенеровані міста очищено (SQLite, hexes.geojson, pipeline, Vite, __pycache__)"

generate генерувати:
ifeq ($(strip $(CITY)),)
	$(PYTHON) -m pipeline
else
	$(PYTHON) -m pipeline "$(CITY)"
endif

generate-all генерувати-всі:
	@set -e; \
	for meta in microservices/data/data/cities/*/meta.json; do \
		[ -f "$$meta" ] || continue; \
		name=$$($(PYTHON) -c "import json,sys; print(json.load(open(sys.argv[1]))['name'])" "$$meta"); \
		echo "==> $$name"; \
		$(PYTHON) -m pipeline "$$name"; \
	done

PROTOC = PATH="$$(go env GOPATH)/bin:$$PATH" protoc
PROTO_DIR = proto

# One invocation, one output module (urban/gen) shared by every service.
# Previously each service carried its own byte-identical copy of the stubs.
proto:
	$(PROTOC) --proto_path=$(PROTO_DIR) \
		--go_out=gen --go_opt=module=urban/gen \
		--go-grpc_out=gen --go-grpc_opt=module=urban/gen \
		hex/v1/hex.proto llm/v1/llm.proto

test: test-go test-py test-web

test-go:
	go vet ./gateway/... ./microservices/hex/... ./microservices/llm/... ./gen/... ./pkg/...
	go test ./gateway/... ./microservices/hex/... ./microservices/llm/... ./gen/... ./pkg/...

test-py:
	cd microservices/data && $(PYTHON) -m pytest

test-web:
	npm --prefix frontend run build
	npm --prefix frontend test

lint:
	go vet ./gateway/... ./microservices/hex/... ./microservices/llm/... ./gen/... ./pkg/...
	npm --prefix frontend run lint
	$(PYTHON) -m ruff check microservices/data contracts/codegen.py

# Regenerating must be a no-op on a clean tree; otherwise generated code is stale.
contract-check:
	$(PYTHON) contracts/codegen.py
	git diff --exit-code -- contracts frontend/src/scoring/generated gen/contract

proto-check: proto
	git diff --exit-code -- gen
