# syntax=docker/dockerfile:1.7

# ---- Stage 1: build the Preact + Vite frontend ----
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: build the Go server ----
# Pure-Go SQLite (modernc.org/sqlite) means CGO_ENABLED=0 -> single static binary.
FROM golang:1.22-alpine AS backend
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
RUN go build -trimpath -ldflags="-s -w" -o /out/djclaude ./cmd/server

# ---- Stage 3: minimal runtime ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S app && adduser -S -G app app && \
    mkdir -p /data /app/frontend/dist && \
    chown -R app:app /data /app
WORKDIR /app
COPY --from=backend  /out/djclaude          /app/djclaude
COPY --from=frontend /app/frontend/dist     /app/frontend/dist
USER app

ENV ADDR=:8080 \
    DATABASE_PATH=/data/karaoke.db \
    STATIC_DIR=/app/frontend/dist

EXPOSE 8080
CMD ["/app/djclaude"]
