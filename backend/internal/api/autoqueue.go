package api

import (
	"context"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
)

// autoEnqueueEnabled returns true if the admin has flipped
// library.auto_enqueue_on_fallback in the settings table. Default off.
func (s *Server) autoEnqueueEnabled(ctx context.Context) bool {
	v, err := s.store.GetSetting(ctx, SettingAutoEnqueue)
	return err == nil && v == "1"
}

// autoEnqueueJob creates a background processing job for a URL that just
// played in fallback mode, so the next play is from the library. Avoids
// duplicates by checking the media table first; failure is logged but
// doesn't block the request response.
func (s *Server) autoEnqueueJob(ctx context.Context, youtubeURL, titleHint string) {
	// already in library?
	// (cheap pre-check; CreateJob would short-circuit too via the explicit
	// path, but we avoid even logging an attempt for known songs.)
	go func() {
		j := models.Job{
			ID:         NewID(),
			YoutubeURL: youtubeURL,
			TitleHint:  strings.TrimSpace(titleHint),
			Priority:   -10, // background; foreground manual jobs outrank this
			Status:     models.JobQueued,
			CreatedAt:  time.Now().UTC(),
		}
		bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.store.CreateJob(bg, j); err != nil {
			log.Printf("auto-enqueue: %v", err)
			return
		}
		s.kickWorker()
	}()
}

// workerHealth proxies GET /api/health/worker → worker's /health.
// Lets the admin dashboard show GPU info and pipeline readiness with one call.
func (s *Server) workerHealth(w http.ResponseWriter, r *http.Request) {
	if s.cfg.WorkerURL == "" {
		writeError(w, http.StatusServiceUnavailable, "WORKER_URL not configured")
		return
	}
	client := &http.Client{Timeout: 3 * time.Second}
	url := strings.TrimRight(s.cfg.WorkerURL, "/") + "/health"
	resp, err := client.Get(url)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok":    false,
			"error": err.Error(),
		})
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
