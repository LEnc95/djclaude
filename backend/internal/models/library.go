package models

import "time"

// Song is the canonical, deduplicated library entry. One Song can have many
// Media (re-renders, different YouTube sources), but exactly one is marked
// primary and used for playback.
type Song struct {
	ID             string    `json:"id"`
	Title          string    `json:"title"`
	Artist         string    `json:"artist"`
	Year           *int      `json:"year,omitempty"`
	DurationSec    int       `json:"duration_sec"`
	CanonicalHash  string    `json:"canonical_hash"`
	PrimaryMediaID string    `json:"primary_media_id,omitempty"`
	Status         SongStatus `json:"status"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`

	// PrimaryMedia is embedded by the API when the caller asks for full song details.
	PrimaryMedia *Media `json:"primary_media,omitempty"`
}

type SongStatus string

const (
	SongPending SongStatus = "pending"
	SongReady   SongStatus = "ready"
	SongFailed  SongStatus = "failed"
)

// Media is one processed artifact: the instrumental .webm + lyrics JSON +
// thumbnail. Paths are relative to MEDIA_DIR.
type Media struct {
	ID                string    `json:"id"`
	SongID            string    `json:"song_id"`
	SourceURL         string    `json:"source_url"`
	SourceVideoID     string    `json:"source_video_id,omitempty"`
	InstrumentalPath  string    `json:"instrumental_path"`
	LyricsPath        string    `json:"lyrics_path"`
	ThumbPath         string    `json:"thumb_path,omitempty"`
	Bytes             int64     `json:"bytes"`
	CreatedAt         time.Time `json:"created_at"`
}

// PublicURL helpers — relative paths become absolute /media/... routes
// at the HTTP layer.
func (m Media) InstrumentalURL() string { return "/media/" + m.InstrumentalPath }
func (m Media) LyricsURL() string       { return "/media/" + m.LyricsPath }
func (m Media) ThumbURL() string {
	if m.ThumbPath == "" {
		return ""
	}
	return "/media/" + m.ThumbPath
}
