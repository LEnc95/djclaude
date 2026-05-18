package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
	"github.com/lukeencrapera/djclaude/backend/internal/store"
)

// GET /api/library/songs?q=&artist=&year=&status=&limit=
func (s *Server) listLibrarySongs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.SongFilter{
		Query:  strings.TrimSpace(q.Get("q")),
		Artist: strings.TrimSpace(q.Get("artist")),
		Status: models.SongStatus(q.Get("status")),
		Limit:  parseInt(q.Get("limit"), 100),
	}
	if y := q.Get("year"); y != "" {
		if n, err := strconv.Atoi(y); err == nil {
			f.Year = &n
		}
	}
	songs, err := s.store.ListSongs(r.Context(), f)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Inline primary media for the common case (player uses it directly).
	out := make([]models.Song, 0, len(songs))
	for _, sg := range songs {
		if sg.PrimaryMediaID != "" {
			if m, err := s.store.GetMedia(r.Context(), sg.PrimaryMediaID); err == nil {
				sg.PrimaryMedia = &m
			}
		}
		out = append(out, sg)
	}
	writeJSON(w, http.StatusOK, out)
}

// GET /api/library/songs/:id
func (s *Server) getLibrarySong(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sg, err := s.store.GetSong(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if sg.PrimaryMediaID != "" {
		if m, err := s.store.GetMedia(r.Context(), sg.PrimaryMediaID); err == nil {
			sg.PrimaryMedia = &m
		}
	}
	writeJSON(w, http.StatusOK, sg)
}

// DELETE /api/library/songs/:id  — removes DB rows AND on-disk media files.
func (s *Server) deleteLibrarySong(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	medias, err := s.store.ListMediaForSong(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := s.store.DeleteSong(r.Context(), id); err != nil {
		writeStoreError(w, err)
		return
	}
	// Best-effort file cleanup. If files survive the DB delete that's fine —
	// they're orphaned but harmless and admin can purge later.
	for _, m := range medias {
		s.deleteMediaFiles(m)
	}
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/library/search   { q }
// Used by guest "find a song" autocomplete. Returns Songs + a small
// "no_match" indicator if nothing matches (frontend then offers fallback).
func (s *Server) searchLibrary(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Q string `json:"q"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.Q = strings.TrimSpace(req.Q)
	if req.Q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"songs": []models.Song{}, "no_match": true})
		return
	}
	songs, err := s.store.ListSongs(r.Context(), store.SongFilter{
		Query: req.Q, Status: models.SongReady, Limit: 25,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"songs":    songs,
		"no_match": len(songs) == 0,
	})
}
