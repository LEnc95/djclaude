// Package api wires the HTTP REST + WebSocket routes for the karaoke app.
//
// Routing uses Go 1.22's stdlib http.ServeMux with method-prefixed patterns.
// We deliberately avoid an HTTP router dependency.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/lukeencrapera/djclaude/backend/internal/config"
	"github.com/lukeencrapera/djclaude/backend/internal/models"
	"github.com/lukeencrapera/djclaude/backend/internal/queue"
	"github.com/lukeencrapera/djclaude/backend/internal/store"
	"github.com/lukeencrapera/djclaude/backend/internal/ws"
	"github.com/lukeencrapera/djclaude/backend/internal/youtube"
)

type Server struct {
	cfg   config.Config
	store store.Store
	hub   *ws.Hub
}

func NewServer(cfg config.Config, st store.Store, hub *ws.Hub) *Server {
	return &Server{cfg: cfg, store: st, hub: hub}
}

func (s *Server) Register(mux *http.ServeMux) {
	// Events
	mux.HandleFunc("POST /api/events", s.createEvent)
	mux.HandleFunc("GET /api/events/{code}", s.getEvent)
	mux.HandleFunc("PATCH /api/events/{code}", s.updateEvent)

	// Requests
	mux.HandleFunc("GET /api/events/{code}/requests", s.listRequests)
	mux.HandleFunc("POST /api/events/{code}/requests", s.createRequest)
	mux.HandleFunc("PATCH /api/events/{code}/requests/{id}", s.updateRequest)
	mux.HandleFunc("DELETE /api/events/{code}/requests/{id}", s.deleteRequest)

	// WebSocket
	mux.HandleFunc("GET /ws/{code}", s.serveWS)

	// Health
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
}

// ----- request DTOs -----

type createEventReq struct {
	VenueName      string `json:"venue_name"`
	Name           string `json:"name"`
	PerSingerLimit int    `json:"per_singer_limit"`
	AutoAccept     *bool  `json:"auto_accept"`
}

type updateEventReq struct {
	Status            *models.EventStatus `json:"status"`
	AcceptingRequests *bool               `json:"accepting_requests"`
	AutoAccept        *bool               `json:"auto_accept"`
	PerSingerLimit    *int                `json:"per_singer_limit"`
	Name              *string             `json:"name"`
	VenueName         *string             `json:"venue_name"`
}

type createRequestReq struct {
	SingerName string `json:"singer_name"`
	SongInput  string `json:"song_input"`
	Notes      string `json:"notes"`
	SongTitle  string `json:"song_title"`
}

type updateRequestReq struct {
	Status      *models.RequestStatus `json:"status"`
	SingerName  *string               `json:"singer_name"`
	YoutubeURL  *string               `json:"youtube_url"`
	SongTitle   *string               `json:"song_title"`
	Notes       *string               `json:"notes"`
	ManualOrder *int                  `json:"manual_order"`
}

// ----- handlers -----

func (s *Server) createEvent(w http.ResponseWriter, r *http.Request) {
	var req createEventReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.VenueName = strings.TrimSpace(req.VenueName)
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.VenueName == "" {
		req.VenueName = "Karaoke"
	}
	if req.PerSingerLimit <= 0 {
		req.PerSingerLimit = s.cfg.PerSingerLimit
	}
	auto := s.cfg.AutoAccept
	if req.AutoAccept != nil {
		auto = *req.AutoAccept
	}

	// Retry a couple times in the (astronomically unlikely) event of a code collision.
	ctx := r.Context()
	var ev models.Event
	for attempt := 0; attempt < 5; attempt++ {
		ev = models.Event{
			ID:                NewID(),
			Code:              NewEventCode(),
			VenueName:         req.VenueName,
			Name:              req.Name,
			Status:            models.EventActive,
			AcceptingRequests: true,
			AutoAccept:        auto,
			PerSingerLimit:    req.PerSingerLimit,
			HostToken:         NewHostToken(),
			CreatedAt:         time.Now().UTC(),
		}
		err := s.store.CreateEvent(ctx, ev)
		if err == nil {
			break
		}
		if !errors.Is(err, store.ErrConflict) {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	writeJSON(w, http.StatusCreated, ev)
}

func (s *Server) getEvent(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	ev, err := s.store.GetEventByCode(r.Context(), code)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !s.isHost(r, ev) {
		ev = ev.Public()
	}
	writeJSON(w, http.StatusOK, ev)
}

func (s *Server) updateEvent(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	ev, err := s.store.GetEventByCode(r.Context(), code)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !s.isHost(r, ev) {
		writeError(w, http.StatusUnauthorized, "host token required")
		return
	}
	var req updateEventReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Status != nil {
		ev.Status = *req.Status
	}
	if req.AcceptingRequests != nil {
		ev.AcceptingRequests = *req.AcceptingRequests
	}
	if req.AutoAccept != nil {
		ev.AutoAccept = *req.AutoAccept
	}
	if req.PerSingerLimit != nil && *req.PerSingerLimit > 0 {
		ev.PerSingerLimit = *req.PerSingerLimit
	}
	if req.Name != nil {
		ev.Name = *req.Name
	}
	if req.VenueName != nil {
		ev.VenueName = *req.VenueName
	}
	if err := s.store.UpdateEvent(r.Context(), ev); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ev)
	s.hub.Broadcast(ev.Code, ws.Event{Type: "event:updated", Payload: ev.Public()})
}

func (s *Server) listRequests(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	ev, err := s.store.GetEventByCode(r.Context(), code)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	host := s.isHost(r, ev)

	statuses := parseStatuses(r.URL.Query().Get("status"))
	if !host && len(statuses) == 0 {
		// Default visibility for guests: only the live queue + now-singing.
		statuses = []models.RequestStatus{models.StatusAccepted, models.StatusSinging}
	}

	reqs, err := s.store.ListRequests(r.Context(), store.RequestFilter{EventID: ev.ID, Statuses: statuses})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !host {
		for i := range reqs {
			reqs[i].GuestID = "" // don't leak other guests' ids
		}
	}
	writeJSON(w, http.StatusOK, reqs)
}

func (s *Server) createRequest(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	ev, err := s.store.GetEventByCode(r.Context(), code)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if ev.Status == models.EventClosed {
		writeError(w, http.StatusConflict, "event is closed")
		return
	}
	if !ev.AcceptingRequests {
		writeError(w, http.StatusConflict, "requests are not being accepted right now")
		return
	}
	var req createRequestReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.SingerName = strings.TrimSpace(req.SingerName)
	req.SongInput = strings.TrimSpace(req.SongInput)
	req.Notes = strings.TrimSpace(req.Notes)
	req.SongTitle = strings.TrimSpace(req.SongTitle)
	if req.SingerName == "" {
		writeError(w, http.StatusBadRequest, "singer_name is required")
		return
	}
	if len(req.SingerName) > 80 {
		req.SingerName = req.SingerName[:80]
	}
	if req.SongInput == "" {
		writeError(w, http.StatusBadRequest, "song_input is required")
		return
	}

	if err := queue.EnforceCap(r.Context(), s.store, ev.ID, req.SingerName, ev.PerSingerLimit); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	url, videoID, songTitle := normalizeRequestSong(req.SongInput, req.SongTitle)

	dup, err := s.store.FindDuplicate(r.Context(), ev.ID, videoID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	status := models.StatusPending
	if ev.AutoAccept {
		status = models.StatusAccepted
	}

	now := time.Now().UTC()
	newReq := models.Request{
		ID:             NewID(),
		EventID:        ev.ID,
		SingerName:     req.SingerName,
		YoutubeURL:     url,
		YoutubeVideoID: videoID,
		SongTitle:      songTitle,
		Notes:          req.Notes,
		Status:         status,
		IsDuplicate:    dup,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := queue.AssignRotationIndex(r.Context(), s.store, &newReq); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.store.CreateRequest(r.Context(), newReq); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// For the guest response include their queue position.
	all, _ := s.store.ListRequests(r.Context(), store.RequestFilter{EventID: ev.ID})
	position := queue.EstimatePosition(all, newReq.ID)

	writeJSON(w, http.StatusCreated, map[string]any{
		"request":  newReq,
		"position": position,
	})
	s.hub.Broadcast(ev.Code, ws.Event{Type: "request:created", Payload: newReq})
}

func (s *Server) updateRequest(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	id := r.PathValue("id")
	ev, err := s.store.GetEventByCode(r.Context(), code)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !s.isHost(r, ev) {
		writeError(w, http.StatusUnauthorized, "host token required")
		return
	}
	cur, err := s.store.GetRequest(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if cur.EventID != ev.ID {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	var req updateRequestReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if req.Status != nil {
		// When moving someone to "singing", demote anyone else who is.
		if *req.Status == models.StatusSinging {
			if err := s.demoteCurrentSinging(r.Context(), ev.ID, cur.ID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		cur.Status = *req.Status
	}
	if req.SingerName != nil {
		cur.SingerName = strings.TrimSpace(*req.SingerName)
	}
	if req.YoutubeURL != nil {
		cur.YoutubeURL = strings.TrimSpace(*req.YoutubeURL)
		cur.YoutubeVideoID = youtube.ParseVideoID(cur.YoutubeURL)
	}
	if req.SongTitle != nil {
		cur.SongTitle = strings.TrimSpace(*req.SongTitle)
	}
	if req.Notes != nil {
		cur.Notes = strings.TrimSpace(*req.Notes)
	}
	if req.ManualOrder != nil {
		cur.ManualOrder = *req.ManualOrder
	}

	if err := s.store.UpdateRequest(r.Context(), cur); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cur)
	s.hub.Broadcast(ev.Code, ws.Event{Type: "request:updated", Payload: cur})
}

func (s *Server) deleteRequest(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	id := r.PathValue("id")
	ev, err := s.store.GetEventByCode(r.Context(), code)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if !s.isHost(r, ev) {
		writeError(w, http.StatusUnauthorized, "host token required")
		return
	}
	cur, err := s.store.GetRequest(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if cur.EventID != ev.ID {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := s.store.DeleteRequest(r.Context(), id); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
	s.hub.Broadcast(ev.Code, ws.Event{Type: "request:deleted", Payload: map[string]string{"id": id}})
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	ev, err := s.store.GetEventByCode(r.Context(), code)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	host := s.isHost(r, ev)

	reqs, err := s.store.ListRequests(r.Context(), store.RequestFilter{EventID: ev.ID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	pubEv := ev.Public()
	if host {
		pubEv = ev
	} else {
		// Hide other guests' ids in the initial snapshot too.
		for i := range reqs {
			reqs[i].GuestID = ""
		}
	}
	snapshot := ws.Event{
		Type: "snapshot",
		Payload: map[string]any{
			"event":    pubEv,
			"requests": reqs,
		},
	}
	s.hub.Serve(w, r, ev.Code, host, snapshot)
}

// ----- helpers -----

func (s *Server) demoteCurrentSinging(ctx context.Context, eventID, exceptID string) error {
	cur, err := s.store.ListRequests(ctx, store.RequestFilter{
		EventID:  eventID,
		Statuses: []models.RequestStatus{models.StatusSinging},
	})
	if err != nil {
		return err
	}
	for _, r := range cur {
		if r.ID == exceptID {
			continue
		}
		r.Status = models.StatusAccepted
		if err := s.store.UpdateRequest(ctx, r); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) isHost(r *http.Request, ev models.Event) bool {
	tok := r.Header.Get("X-Host-Token")
	if tok == "" {
		tok = r.URL.Query().Get("host_token")
	}
	return tok != "" && tok == ev.HostToken
}

func normalizeRequestSong(input, title string) (url, videoID, songTitle string) {
	input = strings.TrimSpace(input)
	songTitle = strings.TrimSpace(title)

	videoID = youtube.ParseVideoID(input)
	if videoID != "" {
		return youtube.WatchURL(videoID), videoID, songTitle
	}
	if songTitle == "" {
		songTitle = input
	}
	return "", "", songTitle
}

func parseStatuses(s string) []models.RequestStatus {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]models.RequestStatus, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, models.RequestStatus(p))
		}
	}
	return out
}

func decodeJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("write json: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "conflict")
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}
