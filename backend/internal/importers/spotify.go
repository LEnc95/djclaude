package importers

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Spotify uses Client Credentials OAuth. Token lives ~1 hour; we cache it.
// Only used if SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are set.
type Spotify struct {
	clientID     string
	clientSecret string

	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

func NewSpotify(id, secret string) *Spotify {
	return &Spotify{clientID: id, clientSecret: secret}
}

func (*Spotify) Name() string { return "spotify" }

// Find: query is interpreted as a year ("1985") or a free-text search
// ("billboard 2023"). Spotify's `year:` filter is supported natively.
func (s *Spotify) Find(ctx context.Context, query string, limit int) ([]Candidate, error) {
	tok, err := s.token4(ctx)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 50 {
		limit = 50 // Spotify search caps each page at 50
	}

	q := strings.TrimSpace(query)
	if len(q) == 4 && q[0] >= '1' && q[0] <= '9' {
		q = "year:" + q
	}

	u := url.Values{}
	u.Set("q", q)
	u.Set("type", "track")
	u.Set("limit", fmt.Sprintf("%d", limit))

	var r struct {
		Tracks struct {
			Items []struct {
				Name    string `json:"name"`
				Artists []struct {
					Name string `json:"name"`
				} `json:"artists"`
				Album struct {
					ReleaseDate string `json:"release_date"`
				} `json:"album"`
			} `json:"items"`
		} `json:"tracks"`
	}
	hdrs := map[string]string{"Authorization": "Bearer " + tok}
	if err := doJSON(ctx, "https://api.spotify.com/v1/search?"+u.Encode(), hdrs, &r); err != nil {
		return nil, err
	}

	out := make([]Candidate, 0, len(r.Tracks.Items))
	for _, t := range r.Tracks.Items {
		if len(t.Artists) == 0 {
			continue
		}
		c := Candidate{Title: t.Name, Artist: t.Artists[0].Name}
		if len(t.Album.ReleaseDate) >= 4 {
			if y, err := parseYear(t.Album.ReleaseDate[:4]); err == nil {
				c.Year = &y
			}
		}
		out = append(out, c)
	}
	return out, nil
}

func (s *Spotify) token4(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token != "" && time.Now().Before(s.expiresAt) {
		return s.token, nil
	}
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://accounts.spotify.com/api/token",
		strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	creds := base64.StdEncoding.EncodeToString([]byte(s.clientID + ":" + s.clientSecret))
	req.Header.Set("Authorization", "Basic "+creds)
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("spotify token → HTTP %d", resp.StatusCode)
	}
	var t struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := decodeJSON(resp.Body, &t); err != nil {
		return "", err
	}
	s.token = t.AccessToken
	// Pad the expiry by 60 sec so we don't race the actual expiry.
	s.expiresAt = time.Now().Add(time.Duration(t.ExpiresIn-60) * time.Second)
	return s.token, nil
}

func parseYear(s string) (int, error) {
	y := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("not a year: %s", s)
		}
		y = y*10 + int(c-'0')
	}
	return y, nil
}
