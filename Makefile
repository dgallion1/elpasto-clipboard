.PHONY: dev dev-frontend dev-backend build build-frontend build-backend start check lint test clean docker docker-up docker-up-turn docker-down docker-logs install reset funnel funnel-off help go-backend-run go-backend-build go-backend-test docker-deploy docker-deploy-turn tunnel tunnel-test tunnel-all go-vet go-static go-vuln go-test go-race go-fuzz go-check

PORT ?= 3000
FUNNEL_PORT ?= 8443
DOCKER_PORT ?= 3001
GO_BACKEND_PORT ?= 8080
GO_CACHE_DIR ?= $(CURDIR)/.cache/go-build

# Deploy targets default to localhost; override via deploy.local.mk (gitignored)
# Copy deploy.local.mk.example to deploy.local.mk and edit for your environment.
DEPLOY_HOST ?= localhost
DEPLOY_PATH ?= ~/elpasto
SSH ?= ssh
RSYNC ?= rsync

# Local override file (gitignored). Variables set here win.
-include deploy.local.mk

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	pnpm install --frozen-lockfile

dev: ## Start Next.js dev + Go backend together
	@make -j2 dev-frontend dev-backend

dev-frontend:
	NEXT_PUBLIC_GO_BACKEND_PORT=$(GO_BACKEND_PORT) pnpm next dev -p $(PORT)

dev-backend:
	mkdir -p $(GO_CACHE_DIR)
	cd backend && GOCACHE=$(GO_CACHE_DIR) PORT=$(GO_BACKEND_PORT) go run ./cmd/elpasto

build-frontend: ## Build Next.js and package embedded frontend assets
	pnpm run build
	sh scripts/build-frontend.sh

build-backend: ## Build Go backend binary
	mkdir -p $(GO_CACHE_DIR)
	cd backend && GOCACHE=$(GO_CACHE_DIR) go build -o elpasto ./cmd/elpasto

build: build-frontend build-backend ## Build frontend assets and Go binary

start: build-backend ## Start production Go binary
	cd backend && PORT=$(PORT) ./elpasto

check: ## Run type-check, lint, tests, and full Go quality pipeline
	pnpm tsc --noEmit
	pnpm run lint
	pnpm vitest run
	@$(MAKE) go-check

lint: ## Run linter
	pnpm run lint

test: ## Run tests
	pnpm vitest run

go-backend-run: ## Start Go backend on port $(GO_BACKEND_PORT)
	mkdir -p $(GO_CACHE_DIR)
	cd backend && GOCACHE=$(GO_CACHE_DIR) PORT=$(GO_BACKEND_PORT) go run ./cmd/elpasto

go-backend-build: build-backend ## Build Go backend

go-backend-test: ## Run Go backend tests
	mkdir -p $(GO_CACHE_DIR)
	cd backend && GOCACHE=$(GO_CACHE_DIR) go test ./...

go-vet: ## Run go vet for suspicious constructs
	cd backend && go vet ./...

go-static: ## Run staticcheck for correctness/performance issues
	cd backend && staticcheck ./...

go-vuln: ## Run govulncheck for dependency vulnerabilities
	cd backend && govulncheck ./...

go-test: ## Run Go tests (alias for go-backend-test)
	mkdir -p $(GO_CACHE_DIR)
	cd backend && GOCACHE=$(GO_CACHE_DIR) go test ./...

go-race: ## Run Go tests with race detector
	mkdir -p $(GO_CACHE_DIR)
	cd backend && GOCACHE=$(GO_CACHE_DIR) go test -race ./...

go-fuzz: ## Run Go fuzz tests (Ctrl+C to stop)
	mkdir -p $(GO_CACHE_DIR)
	cd backend && GOCACHE=$(GO_CACHE_DIR) go test -fuzz=Fuzz -run=^$$ ./...

go-check: ## Run full Go quality pipeline (vet → static → vuln → test → race)
	@echo "→ go vet"
	cd backend && go vet ./...
	@echo "→ staticcheck"
	cd backend && staticcheck ./...
	@echo "→ govulncheck"
	cd backend && govulncheck ./...
	@echo "→ go test"
	mkdir -p $(GO_CACHE_DIR)
	cd backend && GOCACHE=$(GO_CACHE_DIR) go test -p 1 ./...
	@echo "→ go test -race"
	cd backend && GOCACHE=$(GO_CACHE_DIR) go test -race -p 1 ./...
	@echo "✓ all Go checks passed"

tunnel: ## Build elpasto-tunnel CLI binary
	mkdir -p $(GO_CACHE_DIR)
	cd backend && GOCACHE=$(GO_CACHE_DIR) go build -o elpasto-tunnel ./cmd/elpasto-tunnel

tunnel-test: ## Run Go tunnel package tests
	mkdir -p $(GO_CACHE_DIR)
	cd backend && GOCACHE=$(GO_CACHE_DIR) go test ./internal/tunnel/...

TUNNEL_TARGETS = darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64

tunnel-all: ## Build elpasto-tunnel for all supported platforms
	mkdir -p $(GO_CACHE_DIR) backend/downloads
	@for target in $(TUNNEL_TARGETS); do \
		os=$${target%/*}; \
		arch=$${target#*/}; \
		ext=""; \
		if [ "$$os" = "windows" ]; then ext=".exe"; fi; \
		echo "Building elpasto-tunnel-$$os-$$arch$$ext"; \
		cd backend && GOCACHE=$(GO_CACHE_DIR) CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch \
			go build -o downloads/elpasto-tunnel-$$os-$$arch$$ext ./cmd/elpasto-tunnel && cd ..; \
	done

TUNNEL_EXAMPLE_PORT ?= 9000
TUNNEL_EXAMPLE_SERVER ?= http://localhost:$(DOCKER_PORT)

tunnel-example: tunnel ## Run example web app on port 9000 and tunnel it via elpasto
	@if [ -z "$(TOKEN)" ]; then echo "Usage: make tunnel-example TOKEN=your-session-token [SERVER=https://your-elpasto-server] [PORT=9000]"; exit 1; fi
	@trap 'kill 0' EXIT; \
	( cd example && node server.js ) & \
	sleep 1 && \
	./backend/elpasto-tunnel -session $(TOKEN) -port $(TUNNEL_EXAMPLE_PORT) -server $(TUNNEL_EXAMPLE_SERVER)

clean: ## Remove build artifacts
	rm -rf .next
	rm -rf .cache
	find backend/internal/frontend/dist -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +

reset: clean ## Clean and reinstall
	rm -rf node_modules
	pnpm install --frozen-lockfile

docker: ## Build Docker image
	docker compose build

docker-up: ## Start with Docker Compose (port $(DOCKER_PORT))
	PORT=$(DOCKER_PORT) docker compose up -d
	-docker compose stop coturn

docker-up-turn: ## Start with Docker Compose + TURN profile (port $(DOCKER_PORT))
	COMPOSE_PROFILES=turn PORT=$(DOCKER_PORT) docker compose up -d

docker-down: ## Stop Docker Compose
	docker compose down

docker-logs: ## Tail Docker logs
	docker compose logs -f

funnel: ## Expose via Tailscale Funnel on port $(FUNNEL_PORT)
	sudo tailscale funnel --bg --https $(FUNNEL_PORT) http://localhost:$(DOCKER_PORT)

funnel-off: ## Disable Tailscale Funnel
	sudo tailscale funnel --https $(FUNNEL_PORT) off

RSYNC_EXCLUDES = \
	--exclude='node_modules' \
	--exclude='.next' \
	--exclude='data' \
	--exclude='.worktrees' \
	--exclude='.cache' \
	--exclude='backend/downloads' \
	--exclude='backend/elpasto-tunnel' \
	--exclude='backend/coverage.out' \
	--exclude='coverage' \
	--exclude='.superpowers' \
	--exclude='.agents' \
	--exclude='.agent' \
	--exclude='.claude' \
	--exclude='.env' \
	--exclude='.env.local' \
	--exclude='.env.development' \
	--exclude='deploy.local.mk' \
	--exclude='docs/local-archive'

# Env vars that docker-compose.yml may reference. Values are read from Make's
# environment — both deploy.local.mk definitions and any vars exported in the
# caller shell are auto-imported by Make. Empty values are forwarded as empty
# so compose's ${VAR:-default} fallbacks apply.
DEPLOY_VARS = \
	NEXT_PUBLIC_CF_ANALYTICS_TOKEN \
	NEXT_PUBLIC_PLAUSIBLE_ENABLED \
	STATS_DASHBOARD_KEY \
	PLAUSIBLE_SCRIPT_URL \
	PLAUSIBLE_EVENT_URL \
	TURN_SECRET \
	TURN_SERVER \
	TURN_REALM \
	TURN_EXTERNAL_IP \
	DOWNLOADS_DIR \
	NODE_ENV \
	CORS_ALLOWED_ORIGINS \
	SESSION_EXPIRY_HOURS \
	MAX_CLIP_BYTES \
	MAX_SESSION_BYTES \
	MAX_CLIPS_PER_ZONE \
	CLEANUP_INTERVAL_MS \
	RATE_LIMIT_CREATE_PER_HOUR \
	RATE_LIMIT_BATCH_CREATE_PER_HOUR \
	RATE_LIMIT_LOOKUPS_PER_MINUTE \
	RATE_LIMIT_SIGNALS_PER_MINUTE \
	RATE_LIMIT_UPLOADS_PER_MINUTE \
	RATE_LIMIT_TUNNEL_AUTH_STARTS_PER_HOUR \
	RATE_LIMIT_TUNNEL_AUTH_CALLBACKS_PER_HOUR \
	TRUST_PROXY_HEADERS \
	ENABLE_BATCH_SESSION_CREATE \
	GOOGLE_OAUTH_CLIENT_ID \
	GOOGLE_OAUTH_CLIENT_SECRET \
	TUNNEL_AUTH_SECRET \
	TUNNEL_AUTH_ALLOWED_EMAILS \
	TUNNEL_AUTH_ALLOWED_DOMAINS \
	TUNNEL_BASE_URL

# Quote a value for safe placement inside single quotes in the remote shell.
# Embedded "'" is escaped using the standard close-escape-reopen pattern.
# Values containing $, `, ", or \ should be avoided — they go through the
# local shell's double-quoted recipe context and would need further escaping.
shell-quote = '$(subst ','\'',$1)'

DEPLOY_ENV = $(foreach v,$(DEPLOY_VARS),$(v)=$(call shell-quote,$($(v))))

docker-deploy: ## Deploy to $(DEPLOY_HOST) via rsync + Docker rebuild
	$(RSYNC) -az --delete $(RSYNC_EXCLUDES) . $(DEPLOY_HOST):$(DEPLOY_PATH)/
	$(SSH) $(DEPLOY_HOST) "export $(DEPLOY_ENV); DOCKER_BUILDKIT=1 docker compose -f $(DEPLOY_PATH)/docker-compose.yml build && PORT=$(DOCKER_PORT) docker compose -f $(DEPLOY_PATH)/docker-compose.yml up -d && (docker compose -f $(DEPLOY_PATH)/docker-compose.yml stop coturn || true)"

docker-deploy-turn: ## Deploy to $(DEPLOY_HOST) with TURN profile enabled
	$(RSYNC) -az --delete $(RSYNC_EXCLUDES) . $(DEPLOY_HOST):$(DEPLOY_PATH)/
	$(SSH) $(DEPLOY_HOST) "export $(DEPLOY_ENV); DOCKER_BUILDKIT=1 docker compose -f $(DEPLOY_PATH)/docker-compose.yml build && COMPOSE_PROFILES=turn PORT=$(DOCKER_PORT) docker compose -f $(DEPLOY_PATH)/docker-compose.yml up -d"
