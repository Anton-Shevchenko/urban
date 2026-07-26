.PHONY: help start stop clear-cache generate generate-all \
	старт стоп скинути-кеш генерувати генерувати-всі

COMPOSE ?= docker compose
PYTHON  ?= ./.venv/bin/python
CITY    ?=

help:
	@echo "Targets:"
	@echo "  make start                    — підняти API + frontend (docker compose)"
	@echo "  make stop                     — зупинити контейнери"
	@echo "  make clear-cache              — скинути pipeline / Vite кеш"
	@echo "  make generate CITY=Hamburg    — згенерувати кеш для міста"
	@echo "  make generate-all             — перегенерувати всі міста з data/cities/"
	@echo ""
	@echo "Аліаси: старт · стоп · скинути-кеш · генерувати · генерувати-всі"

start старт:
	$(COMPOSE) up --build -d
	@echo "UI  → http://localhost:8080"
	@echo "API → http://localhost:8000"

stop стоп:
	$(COMPOSE) down

clear-cache скинути-кеш:
	rm -rf data/cache/*
	rm -rf data/cities/*/cache
	rm -rf frontend/node_modules/.vite
	find . -type d -name __pycache__ -not -path './.venv/*' -exec rm -rf {} + 2>/dev/null || true
	@echo "Кеш очищено (data/cache, data/cities/*/cache, Vite, __pycache__)"

generate генерувати:
ifeq ($(strip $(CITY)),)
	$(PYTHON) -m pipeline.run_all
else
	$(PYTHON) -m pipeline.run_all "$(CITY)"
endif

generate-all генерувати-всі:
	@set -e; \
	for meta in data/cities/*/meta.json; do \
		[ -f "$$meta" ] || continue; \
		name=$$($(PYTHON) -c "import json,sys; print(json.load(open(sys.argv[1]))['name'])" "$$meta"); \
		echo "==> $$name"; \
		$(PYTHON) -m pipeline.run_all "$$name"; \
	done
