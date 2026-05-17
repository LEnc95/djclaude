package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/lukeencrapera/djclaude/backend/internal/api"
	"github.com/lukeencrapera/djclaude/backend/internal/config"
	"github.com/lukeencrapera/djclaude/backend/internal/store"
	"github.com/lukeencrapera/djclaude/backend/internal/ws"
)

func main() {
	cfg := config.FromEnv()

	st, err := store.NewSQLite(cfg.DatabasePath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	hub := ws.NewHub()
	srv := api.NewServer(cfg, st, hub)

	mux := http.NewServeMux()
	srv.Register(mux)

	// Static frontend: serve `index.html` for any non-API path so the SPA
	// router handles /r/:code and /host/:code.
	staticDir, _ := filepath.Abs(cfg.StaticDir)
	fs := http.FileServer(http.Dir(staticDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/ws/") {
			http.NotFound(w, r)
			return
		}
		// If asking for a real file, serve it.
		path := filepath.Join(staticDir, filepath.FromSlash(r.URL.Path))
		if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		// Otherwise, send index.html for SPA routing.
		http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
	})

	handler := api.CORS(cfg.AllowedOrigins)(mux)
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           withLogging(handler),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("listening on %s (static: %s, db: %s)", cfg.Addr, staticDir, cfg.DatabasePath)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}

func withLogging(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
	})
}
