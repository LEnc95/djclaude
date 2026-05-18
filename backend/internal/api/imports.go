package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/lukeencrapera/djclaude/backend/internal/importers"
	"github.com/lukeencrapera/djclaude/backend/internal/models"
)

// imports.go wires the bulk-import endpoints. Each handler resolves the
// query through an importer source, creates an import_batch row, then
// enqueues a Job for each candidate. The worker picks them up.

type importReq struct {
	Source       string `json:"source"`        // "musicbrainz" | "wikipedia" | "spotify"
	Query        string `json:"query"`         // e.g. "Fleetwood Mac", "1985"
	Limit        int    `json:"limit"`         // candidate cap; 0 → 25
	Priority     int    `json:"priority"`      // applied to every Job
	NotifyEmail  string `json:"notify_email"`
	NotifySlack  string `json:"notify_slack"`
}

func (s *Server) bulkImport(w http.ResponseWriter, r *http.Request, defaultSource string) {
	var req importReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Source == "" {
		req.Source = defaultSource
	}
	src, ok := s.importers.Get(req.Source)
	if !ok {
		writeError(w, http.StatusBadRequest,
			"unknown source; available: "+strings.Join(s.importers.Names(), ", "))
		return
	}

	cands, err := src.Find(r.Context(), strings.TrimSpace(req.Query), req.Limit)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if len(cands) == 0 {
		writeError(w, http.StatusNotFound, "no candidates found")
		return
	}

	now := time.Now().UTC()
	batch := models.ImportBatch{
		ID:          NewID(),
		Kind:        req.Source,
		Query:       req.Query,
		Total:       len(cands),
		NotifyEmail: req.NotifyEmail,
		NotifySlack: req.NotifySlack,
		CreatedAt:   now,
	}
	if err := s.store.CreateBatch(r.Context(), batch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	created := 0
	skipped := 0
	for _, c := range cands {
		// Try to short-circuit if the song is already in the library by
		// canonical hash. We can't dedup by video id here (ytsearch URLs
		// don't have one until the worker resolves), but the hash catches
		// most re-imports.
		hash := CanonicalHash(c.Artist, c.Title)
		if existing, err := s.store.GetSongByHash(r.Context(), hash); err == nil && existing.PrimaryMediaID != "" {
			skipped++
			continue
		}
		j := models.Job{
			ID:         NewID(),
			YoutubeURL: c.SearchURL(),
			TitleHint:  c.Title,
			ArtistHint: c.Artist,
			YearHint:   c.Year,
			Priority:   req.Priority,
			Status:     models.JobQueued,
			BatchID:    batch.ID,
			CreatedAt:  time.Now().UTC(),
		}
		if err := s.store.CreateJob(r.Context(), j); err == nil {
			created++
		}
	}

	s.kickWorker()
	writeJSON(w, http.StatusCreated, map[string]any{
		"batch":    batch,
		"queued":   created,
		"skipped":  skipped,
		"total":    len(cands),
	})
}

func (s *Server) importArtist(w http.ResponseWriter, r *http.Request) {
	s.bulkImport(w, r, "musicbrainz")
}

func (s *Server) importYear(w http.ResponseWriter, r *http.Request) {
	s.bulkImport(w, r, "wikipedia")
}

func (s *Server) importGeneric(w http.ResponseWriter, r *http.Request) {
	s.bulkImport(w, r, "")
}

// =========================================================================
// GET /api/import/batches  — admin sees recent imports + completion %
// =========================================================================

func (s *Server) listBatches(w http.ResponseWriter, r *http.Request) {
	bs, err := s.store.ListBatches(r.Context(), parseInt(r.URL.Query().Get("limit"), 50))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, bs)
}

// GET /api/import/sources  — frontend probes what's available (Spotify
// only shows up if creds were set).
func (s *Server) listImportSources(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"sources": s.importers.Names(),
	})
}

// helper used by other handlers
var _ importers.Source
