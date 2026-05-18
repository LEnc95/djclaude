// Package importers turns a high-level query (artist name, year, chart id)
// into a list of song candidates the worker will then process.
//
// All importers return Candidates with title + artist + year only. The Go
// API turns each Candidate into a Job with `youtube_url = "ytsearch1:..."`
// which yt-dlp resolves to the top YouTube hit at download time. No
// YouTube API key needed.
package importers

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Candidate is one song to enqueue. Year is optional.
type Candidate struct {
	Title  string `json:"title"`
	Artist string `json:"artist"`
	Year   *int   `json:"year,omitempty"`
}

// Source is one importer implementation.
type Source interface {
	Name() string
	Find(ctx context.Context, query string, limit int) ([]Candidate, error)
}

// Registry holds all sources keyed by short name ("musicbrainz", "wikipedia", "spotify").
type Registry struct {
	sources map[string]Source
}

func NewRegistry(spotifyClientID, spotifyClientSecret string) *Registry {
	r := &Registry{sources: map[string]Source{}}
	r.sources["musicbrainz"] = NewMusicBrainz()
	r.sources["wikipedia"] = NewWikipediaCharts()
	if spotifyClientID != "" && spotifyClientSecret != "" {
		r.sources["spotify"] = NewSpotify(spotifyClientID, spotifyClientSecret)
	}
	return r
}

func (r *Registry) Get(name string) (Source, bool) {
	s, ok := r.sources[name]
	return s, ok
}

func (r *Registry) Names() []string {
	out := make([]string, 0, len(r.sources))
	for n := range r.sources {
		out = append(out, n)
	}
	return out
}

// SearchURL converts a Candidate to the yt-dlp pseudo-URL that picks the
// top YouTube result. yt-dlp natively understands "ytsearch1:..." so the
// worker needs no special handling.
func (c Candidate) SearchURL() string {
	q := strings.TrimSpace(c.Artist + " " + c.Title + " karaoke")
	return "ytsearch1:" + q
}

// ----- shared HTTP helper -----

var httpClient = &http.Client{Timeout: 15 * time.Second}

func doJSON(ctx context.Context, url string, headers map[string]string, dst any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "djclaude-pro/0.1 (https://github.com/lukeencrapera/djclaude)")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s → %d", url, resp.StatusCode)
	}
	return decodeJSON(resp.Body, dst)
}
