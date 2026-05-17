// Package ws implements the WebSocket hub. There's one channel per event
// code; the hub fans out events to all subscribers of that channel. Host vs
// guest distinction is made at subscribe time: hosts get the host_token
// field stripped from events too (in practice we only ever broadcast event
// updates via .Public(), so it's symmetric).
package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

// Event is the wire shape broadcast to subscribers.
type Event struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}

type subscriber struct {
	conn *websocket.Conn
	send chan Event
	host bool
}

type Hub struct {
	mu          sync.RWMutex
	subscribers map[string]map[*subscriber]struct{} // by event code
	upgrader    websocket.Upgrader
}

func NewHub() *Hub {
	return &Hub{
		subscribers: map[string]map[*subscriber]struct{}{},
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin:     func(r *http.Request) bool { return true },
		},
	}
}

// Broadcast fans the event out to every subscriber of the given event code.
// Non-blocking per-subscriber: if a client's send buffer is full we drop it.
func (h *Hub) Broadcast(eventCode string, ev Event) {
	h.mu.RLock()
	subs := h.subscribers[eventCode]
	targets := make([]*subscriber, 0, len(subs))
	for s := range subs {
		targets = append(targets, s)
	}
	h.mu.RUnlock()
	for _, s := range targets {
		select {
		case s.send <- ev:
		default:
			// slow client — drop it; their next reconnect will re-snapshot.
			go h.drop(eventCode, s)
		}
	}
}

func (h *Hub) drop(code string, s *subscriber) {
	h.mu.Lock()
	if subs, ok := h.subscribers[code]; ok {
		delete(subs, s)
		if len(subs) == 0 {
			delete(h.subscribers, code)
		}
	}
	h.mu.Unlock()
	_ = s.conn.Close()
}

// Serve upgrades the HTTP request to a WebSocket and registers it under the
// given event code. snapshot is sent immediately upon connect.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, eventCode string, host bool, snapshot Event) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	sub := &subscriber{conn: conn, send: make(chan Event, 32), host: host}

	h.mu.Lock()
	if h.subscribers[eventCode] == nil {
		h.subscribers[eventCode] = map[*subscriber]struct{}{}
	}
	h.subscribers[eventCode][sub] = struct{}{}
	h.mu.Unlock()

	// Prime with snapshot.
	sub.send <- snapshot

	go h.readPump(eventCode, sub)
	go h.writePump(sub)
}

func (h *Hub) readPump(eventCode string, sub *subscriber) {
	defer h.drop(eventCode, sub)
	sub.conn.SetReadLimit(4096)
	_ = sub.conn.SetReadDeadline(time.Now().Add(pongWait))
	sub.conn.SetPongHandler(func(string) error {
		return sub.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		if _, _, err := sub.conn.ReadMessage(); err != nil {
			return
		}
		// We don't expect client-to-server messages in v1.
	}
}

func (h *Hub) writePump(sub *subscriber) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case ev, ok := <-sub.send:
			_ = sub.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = sub.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			b, err := json.Marshal(ev)
			if err != nil {
				log.Printf("ws marshal: %v", err)
				continue
			}
			if err := sub.conn.WriteMessage(websocket.TextMessage, b); err != nil {
				return
			}
		case <-ticker.C:
			_ = sub.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := sub.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
