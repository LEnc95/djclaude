package api

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
	"github.com/lukeencrapera/djclaude/backend/internal/store"
	"github.com/lukeencrapera/djclaude/backend/internal/ws"
	"github.com/lukeencrapera/djclaude/backend/internal/youtube"
)

// =========================================================================
// POST /api/jobs   { youtube_url, title?, artist?, year?, priority? }
// =========================================================================

type createJobReq struct {
	YoutubeURL string `json:"youtube_url"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Year       *int   `json:"year"`
	Priority   int    `json:"priority"`
	BatchID    string `json:"batch_id"`
}

func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	var req createJobReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.YoutubeURL = strings.TrimSpace(req.YoutubeURL)
	if req.YoutubeURL == "" {
		writeError(w, http.StatusBadRequest, "youtube_url is required")
		return
	}
	vid := youtube.ParseVideoID(req.YoutubeURL)
	if vid == "" {
		writeError(w, http.StatusBadRequest, "could not parse a YouTube video id from youtube_url")
		return
	}

	// Dedup short-circuit: same YouTube id already processed.
	if existing, err := s.store.GetMediaByVideoID(r.Context(), vid); err == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"already_processed": true,
			"song_id":           existing.SongID,
			"media_id":          existing.ID,
		})
		return
	}

	j := models.Job{
		ID:         NewID(),
		YoutubeURL: youtube.WatchURL(vid),
		TitleHint:  strings.TrimSpace(req.Title),
		ArtistHint: strings.TrimSpace(req.Artist),
		YearHint:   req.Year,
		Priority:   req.Priority,
		Status:     models.JobQueued,
		BatchID:    req.BatchID,
		CreatedAt:  time.Now().UTC(),
	}
	if err := s.store.CreateJob(r.Context(), j); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	s.kickWorker()
	writeJSON(w, http.StatusCreated, j)
}

// =========================================================================
// GET /api/jobs
// =========================================================================

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.JobFilter{
		BatchID: q.Get("batch_id"),
		Limit:   parseInt(q.Get("limit"), 200),
	}
	if raw := q.Get("status"); raw != "" {
		for _, st := range strings.Split(raw, ",") {
			st = strings.TrimSpace(st)
			if st != "" {
				f.Statuses = append(f.Statuses, models.JobStatus(st))
			}
		}
	}
	jobs, err := s.store.ListJobs(r.Context(), f)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, jobs)
}

func (s *Server) getJob(w http.ResponseWriter, r *http.Request) {
	j, err := s.store.GetJob(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, j)
}

// DELETE /api/jobs/:id  → mark canceled; worker bails next progress tick.
func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) {
	if err := s.store.SetJobStatus(r.Context(), r.PathValue("id"), models.JobCanceled); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) retryJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	j, err := s.store.GetJob(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if j.Status == models.JobRunning || j.Status == models.JobQueued {
		writeError(w, http.StatusConflict, "job is already queued or running")
		return
	}
	j.Status = models.JobQueued
	j.Stage = ""
	j.Progress = 0
	j.Error = ""
	j.StartedAt = nil
	j.FinishedAt = nil
	if err := s.store.UpdateJob(r.Context(), j); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.kickWorker()
	writeJSON(w, http.StatusOK, j)
}

func (s *Server) setJobPriority(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Priority int `json:"priority"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.store.SetJobPriority(r.Context(), r.PathValue("id"), req.Priority); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// POST /api/jobs/:id/callback   [worker → api, requires X-Worker-Token]
// =========================================================================

func (s *Server) jobCallback(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Worker-Token") != s.cfg.WorkerToken {
		writeError(w, http.StatusUnauthorized, "bad worker token")
		return
	}
	id := r.PathValue("id")
	j, err := s.store.GetJob(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// On successful completion, link every pending request that asked for
	// this video while it was being processed (fallback → library upgrade).
	if j.Status == models.JobDone && j.SongID != "" {
		s.linkPendingRequestsToSong(r.Context(), j)
	}
	// Notify admin/host UIs.
	s.hub.Broadcast("_admin", ws.Event{Type: "job:updated", Payload: j})
	w.WriteHeader(http.StatusOK)
}

func (s *Server) linkPendingRequestsToSong(ctx context.Context, j models.Job) {
	vid := youtube.ParseVideoID(j.YoutubeURL)
	if vid == "" {
		return
	}
	pending, err := s.store.ListPendingRequestsByVideoID(ctx, vid)
	if err != nil {
		log.Printf("link pending: %v", err)
		return
	}
	for _, rq := range pending {
		if err := s.store.SetRequestSong(ctx, rq.ID, j.SongID); err != nil {
			continue
		}
		updated, err := s.store.GetRequest(ctx, rq.ID)
		if err != nil {
			continue
		}
		// Look up the event code so we can broadcast on the right channel.
		ev, err := s.store.GetEventByID(ctx, updated.EventID)
		if err == nil {
			s.hub.Broadcast(ev.Code, ws.Event{Type: "request:updated", Payload: updated})
		}
	}
}

// kickWorker pings the worker's /internal/kick so it doesn't wait for the
// poll interval. Best-effort: failure is logged and ignored.
func (s *Server) kickWorker() {
	if s.cfg.WorkerURL == "" {
		return
	}
	go func() {
		req, _ := http.NewRequest(http.MethodPost,
			strings.TrimRight(s.cfg.WorkerURL, "/")+"/internal/kick",
			bytes.NewReader([]byte("{}")))
		req.Header.Set("X-Worker-Token", s.cfg.WorkerToken)
		req.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 2 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			log.Printf("kick worker: %v", err)
			return
		}
		_ = resp.Body.Close()
	}()
}

func parseInt(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

