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

	// Bootstrap the default admin/admin user on first boot (forces a password
	// change on first login). No-op if any admin row already exists.
	if err := api.EnsureDefaultAdmin(context.Background(), st); err != nil {
		log.Fatalf("ensure default admin: %v", err)
	}

	// Make sure the media dir exists; the worker writes files here and the
	// HTTP handler serves them out.
	if err := os.MkdirAll(cfg.MediaDir, 0o755); err != nil {
		log.Fatalf("mkdir media dir: %v", err)
	}

	hub := ws.NewHub()
	srv := api.NewServer(cfg, st, hub)

	mux := http.NewServeMux()
	srv.Register(mux)

	// Static frontend: serve index.html for any non-API/non-media path so the
	// SPA router handles /r/:code, /host/:code, /admin, /screen/:code, etc.
	//
	// Caching policy:
	//   - index.html: Cache-Control: no-cache (must revalidate). Without
	//     this, browsers happily serve a months-old HTML referencing a
	//     stale Vite-hashed JS filename, and users never see new releases
	//     without manually clearing cache.
	//   - /assets/index-<hash>.js|css: filenames are content-hashed by
	//     Vite, so safe to cache forever — a new build = new filename.
	staticDir, _ := filepath.Abs(cfg.StaticDir)
	fs := http.FileServer(http.Dir(staticDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") ||
			strings.HasPrefix(r.URL.Path, "/ws/") ||
			strings.HasPrefix(r.URL.Path, "/media/") {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(staticDir, filepath.FromSlash(r.URL.Path))
		if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
			// Hashed asset (Vite output: /assets/index-XXXX.js|css) — long cache.
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				// Non-asset static file (favicon, robots.txt, etc.) — short cache.
				w.Header().Set("Cache-Control", "public, max-age=300")
			}
			fs.ServeHTTP(w, r)
			return
		}
		// SPA fallback → index.html. Always revalidate so new builds are
		// picked up immediately without users having to clear their cache.
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
	})

	handler := api.CORS(cfg.AllowedOrigins)(mux)
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           withLogging(handler),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("listening on %s (static=%s db=%s media=%s worker=%s)",
			cfg.Addr, staticDir, cfg.DatabasePath, cfg.MediaDir, cfg.WorkerURL)
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
