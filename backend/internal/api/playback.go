package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/lukeencrapera/djclaude/backend/internal/ws"
)

// =========================================================================
// Inbound WS handler — host pushes playback state, server broadcasts to
// all subscribers on the event channel. Guests' phones reconcile their
// local <video> element to match.
//
// Wire shape (host → server):
//   { "type": "playback:state", "payload": {
//       "song_id":      "abc",
//       "current_time": 12.345,
//       "paused":       false,
//       "rate":         1.0,
//       "request_id":   "..."   // optional, what's playing
//   } }
//
// Server adds "server_ts" (ms since unix epoch) before fanout so phones
// can compensate for transit latency: real_t = current_time + (now - server_ts)/1000.
// =========================================================================

type PlaybackState struct {
	SongID      string  `json:"song_id"`
	RequestID   string  `json:"request_id,omitempty"`
	CurrentTime float64 `json:"current_time"`
	Paused      bool    `json:"paused"`
	Rate        float64 `json:"rate"`
	ServerTS    int64   `json:"server_ts"` // ms since unix epoch
}

// handleInboundWS is invoked by the hub for each text message a client sends.
// Returns true if the message was handled (so the hub can log unknown types).
func (s *Server) handleInboundWS(eventCode string, isHost bool, raw []byte) bool {
	var env struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return false
	}
	switch env.Type {
	case "playback:state":
		if !isHost {
			return true // ignore guests pretending to be the host
		}
		var st PlaybackState
		if err := json.Unmarshal(env.Payload, &st); err != nil {
			return false
		}
		st.ServerTS = time.Now().UnixMilli()
		s.hub.Broadcast(eventCode, ws.Event{Type: "playback:state", Payload: st})
		return true
	case "playback:load":
		if !isHost {
			return true
		}
		// Re-broadcast as-is. Guests use it to switch their <video> source.
		var p struct {
			RequestID string `json:"request_id"`
			SongID    string `json:"song_id"`
		}
		_ = json.Unmarshal(env.Payload, &p)
		s.hub.Broadcast(eventCode, ws.Event{Type: "playback:load", Payload: p})
		return true
	case "ping":
		// no-op, used to keep connections warm in some clients
		return true
	}
	return false
}

// =========================================================================
// HTTP fallback: POST /api/events/:code/playback   (host only)
// Same wire shape; for clients that aren't using the WebSocket.
// =========================================================================

func (s *Server) postPlayback(w http.ResponseWriter, r *http.Request) {
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
	var st PlaybackState
	if err := decodeJSON(r, &st); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	st.ServerTS = time.Now().UnixMilli()
	s.hub.Broadcast(ev.Code, ws.Event{Type: "playback:state", Payload: st})
	w.WriteHeader(http.StatusAccepted)
}

