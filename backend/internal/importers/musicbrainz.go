package importers

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// MusicBrainz exposes the free public MusicBrainz JSON API.
// Rate-limited to 1 req/sec by their ToS; we serialize through a channel.
type MusicBrainz struct {
	mu       sync.Mutex
	lastReq  time.Time
}

func NewMusicBrainz() *MusicBrainz { return &MusicBrainz{} }

func (m *MusicBrainz) Name() string { return "musicbrainz" }

// Find returns the artist's most-released recordings, deduplicated by title.
// `query` is the artist name (case-insensitive, fuzzy).
func (m *MusicBrainz) Find(ctx context.Context, query string, limit int) ([]Candidate, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("artist name required")
	}
	if limit <= 0 || limit > 100 {
		limit = 25
	}

	artistID, artistName, err := m.lookupArtistID(ctx, query)
	if err != nil {
		return nil, err
	}

	// Pull recordings; MB returns at most 100 at a time. One page covers the
	// 99% case for "top N songs". For deep discographies we'd paginate but
	// the user-facing batch sizes for this app are small.
	type recordingsResp struct {
		Recordings []struct {
			Title    string `json:"title"`
			Releases []struct {
				Date string `json:"date"`
			} `json:"releases"`
		} `json:"recordings"`
	}
	q := url.Values{}
	q.Set("artist", artistID)
	q.Set("limit", "100")
	q.Set("fmt", "json")

	if err := m.rateLimitWait(ctx); err != nil {
		return nil, err
	}
	var rec recordingsResp
	if err := doJSON(ctx, "https://musicbrainz.org/ws/2/recording/?"+q.Encode(), nil, &rec); err != nil {
		return nil, err
	}

	// Dedup by lower-case title; keep the earliest release year.
	seen := map[string]*Candidate{}
	for _, r := range rec.Recordings {
		t := strings.TrimSpace(r.Title)
		if t == "" {
			continue
		}
		key := strings.ToLower(t)
		yr := earliestYear(r.Releases)
		if existing, ok := seen[key]; ok {
			if yr != nil && (existing.Year == nil || *yr < *existing.Year) {
				existing.Year = yr
			}
			continue
		}
		c := &Candidate{Title: t, Artist: artistName, Year: yr}
		seen[key] = c
	}
	out := make([]Candidate, 0, len(seen))
	for _, c := range seen {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool {
		// Earliest releases first (often the originals, not the live/remaster)
		yi, yj := 9999, 9999
		if out[i].Year != nil {
			yi = *out[i].Year
		}
		if out[j].Year != nil {
			yj = *out[j].Year
		}
		if yi != yj {
			return yi < yj
		}
		return out[i].Title < out[j].Title
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *MusicBrainz) lookupArtistID(ctx context.Context, name string) (id, canonName string, err error) {
	type artistResp struct {
		Artists []struct {
			ID    string `json:"id"`
			Name  string `json:"name"`
			Score int    `json:"score"`
		} `json:"artists"`
	}
	q := url.Values{}
	q.Set("query", "artist:"+name)
	q.Set("limit", "5")
	q.Set("fmt", "json")
	if err := m.rateLimitWait(ctx); err != nil {
		return "", "", err
	}
	var ar artistResp
	if err := doJSON(ctx, "https://musicbrainz.org/ws/2/artist/?"+q.Encode(), nil, &ar); err != nil {
		return "", "", err
	}
	if len(ar.Artists) == 0 {
		return "", "", fmt.Errorf("artist %q not found", name)
	}
	best := ar.Artists[0]
	for _, a := range ar.Artists {
		if a.Score > best.Score {
			best = a
		}
	}
	return best.ID, best.Name, nil
}

// rateLimitWait blocks until at least 1.1s has passed since the previous
// request from this MusicBrainz client (their ToS asks for ≤1 req/sec; we
// pad slightly for clock jitter).
func (m *MusicBrainz) rateLimitWait(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	wait := 1100*time.Millisecond - time.Since(m.lastReq)
	if wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	m.lastReq = time.Now()
	return nil
}

func earliestYear(rels []struct {
	Date string `json:"date"`
}) *int {
	var best *int
	for _, r := range rels {
		if len(r.Date) < 4 {
			continue
		}
		y := 0
		for i := 0; i < 4; i++ {
			c := r.Date[i]
			if c < '0' || c > '9' {
				y = 0
				break
			}
			y = y*10 + int(c-'0')
		}
		if y < 1900 || y > 2100 {
			continue
		}
		if best == nil || y < *best {
			yc := y
			best = &yc
		}
	}
	return best
}
