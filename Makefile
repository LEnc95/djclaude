# DJClaude Makefile — POSIX make. On Windows, use the npm/go commands directly.

.PHONY: dev backend frontend build clean

# Dev: assumes you'll run `make backend` in one shell, `make frontend` in another.
dev:
	@echo "Run 'make backend' and 'make frontend' in separate terminals."

backend:
	cd backend && go run ./cmd/server

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm install && npm run build
	cd backend && go build -o ../djclaude ./cmd/server

clean:
	rm -rf frontend/dist djclaude karaoke.db
