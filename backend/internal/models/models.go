package models

import "time"

type EventStatus string

const (
	EventActive EventStatus = "active"
	EventClosed EventStatus = "closed"
)

type RequestStatus string

const (
	StatusPending  RequestStatus = "pending"
	StatusAccepted RequestStatus = "accepted"
	StatusSinging  RequestStatus = "singing"
	StatusDone     RequestStatus = "done"
	StatusSkipped  RequestStatus = "skipped"
	StatusRejected RequestStatus = "rejected"
)

// IsActive reports whether the request is still in play (counts against
// per-singer caps and contributes to rotation).
func (s RequestStatus) IsActive() bool {
	switch s {
	case StatusPending, StatusAccepted, StatusSinging:
		return true
	}
	return false
}

type Event struct {
	ID                string      `json:"id"`
	Code              string      `json:"code"`
	VenueName         string      `json:"venue_name"`
	Name              string      `json:"name"`
	Status            EventStatus `json:"status"`
	AcceptingRequests bool        `json:"accepting_requests"`
	AutoAccept        bool        `json:"auto_accept"`
	PerSingerLimit    int         `json:"per_singer_limit"`
	HostToken         string      `json:"host_token,omitempty"` // only emitted to the host
	StartsAt          *time.Time  `json:"starts_at,omitempty"`
	EndsAt            *time.Time  `json:"ends_at,omitempty"`
	CreatedAt         time.Time   `json:"created_at"`
}

// PublicEvent strips host-only fields for guest views.
func (e Event) Public() Event {
	pub := e
	pub.HostToken = ""
	return pub
}

type Request struct {
	ID             string        `json:"id"`
	EventID        string        `json:"event_id"`
	SingerName     string        `json:"singer_name"`
	YoutubeURL     string        `json:"youtube_url"`
	YoutubeVideoID string        `json:"youtube_video_id,omitempty"`
	SongTitle      string        `json:"song_title,omitempty"`
	SongID         string        `json:"song_id,omitempty"` // FK to songs.id; empty = fallback to YT
	Notes          string        `json:"notes,omitempty"`
	Status         RequestStatus `json:"status"`
	RotationIndex  int           `json:"rotation_index"` // singer's nth song this event
	ManualOrder    int           `json:"manual_order"`   // DJ-set override; 0 = use rotation
	IsDuplicate    bool          `json:"is_duplicate,omitempty"`
	GuestID        string        `json:"guest_id,omitempty"` // cookie-derived identifier
	CreatedAt      time.Time     `json:"created_at"`
	UpdatedAt      time.Time     `json:"updated_at"`
}
