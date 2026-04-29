.PHONY: build run stop restart logs dev clean typecheck pull help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

build: ## Build the Docker image (injects current commit hash)
	COMMIT_HASH=$$(git rev-parse HEAD 2>/dev/null || echo dev) docker compose build

run: ## Start the service (builds if needed, injects current commit hash)
	COMMIT_HASH=$$(git rev-parse HEAD 2>/dev/null || echo dev) docker compose up --build -d
	@echo "\n  Whisper It running at http://localhost:4000\n"

pull: ## Pull and run the published image from Docker Hub
	docker run --rm -p 4000:4000 -v whisper-models:/models lukevenediger/whisper-it:latest

stop: ## Stop the service
	docker compose down

restart: stop run ## Restart the service

logs: ## Tail container logs
	docker compose logs -f

dev: ## Run locally without Docker (requires Node 20+, Python 3.10+, faster-whisper)
	WHISPER_MODELS_DIR=./models npm run dev

typecheck: ## Run TypeScript type checking
	npx tsc --noEmit

clean: ## Remove Docker containers, images, and model cache
	docker compose down --rmi local --volumes
	@echo "\n  Cleaned containers, images, and model cache.\n"
