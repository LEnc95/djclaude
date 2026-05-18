package models

import "time"

type JobStatus string

const (
	JobQueued   JobStatus = "queued"
	JobRunning  JobStatus = "running"
	JobDone     JobStatus = "done"
	JobFailed   JobStatus = "failed"
	JobCanceled JobStatus = "canceled"
	JobPaused   JobStatus = "paused"
)

// Job represents a single processing run. Higher priority runs first; ties
// broken by created_at (FIFO).
type Job struct {
	ID          string     `json:"id"`
	SongID      string     `json:"song_id,omitempty"` // filled after metadata extraction
	YoutubeURL  string     `json:"youtube_url"`
	TitleHint   string     `json:"title_hint,omitempty"`
	ArtistHint  string     `json:"artist_hint,omitempty"`
	YearHint    *int       `json:"year_hint,omitempty"`
	Priority    int        `json:"priority"`
	Status      JobStatus  `json:"status"`
	Stage       string     `json:"stage,omitempty"`    // 'download'|'separate'|'transcribe'|'render'
	Progress    float64    `json:"progress"`           // 0..1
	Error       string     `json:"error,omitempty"`
	Attempts    int        `json:"attempts"`
	BatchID     string     `json:"batch_id,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
}

// ImportBatch groups jobs that came in together (artist import, year import, csv).
type ImportBatch struct {
	ID           string     `json:"id"`
	Kind         string     `json:"kind"` // 'artist'|'year'|'chart'|'search'|'csv'
	Query        string     `json:"query"`
	Total        int        `json:"total"`
	Completed    int        `json:"completed"`
	Failed       int        `json:"failed"`
	NotifyEmail  string     `json:"notify_email,omitempty"`
	NotifySlack  string     `json:"notify_slack,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
}
