package api

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"regexp"
	"strings"

	"github.com/lukeencrapera/djclaude/backend/internal/store"
)

// Resolver decides whether a guest's submitted song matches an existing
// library song (→ play from /media), or needs YouTube-fallback playback (and
// optionally auto-enqueued for processing).
//
// Match order:
//   1. Exact youtube_video_id → media row (instant library hit).
//   2. canonical_hash(artist, title) → songs row, when caller passed
//      an explicit title (or we can guess one).
//   3. Fuzzy LIKE on title/artist for partial typed search.

type ResolveResult struct {
	SongID         string // empty if no library match
	MediaID        string
	PrimaryMediaID string
}

func (s *Server) resolveRequest(ctx context.Context, videoID, title, artistHint string) ResolveResult {
	// 1. Exact YouTube id match.
	if videoID != "" {
		if m, err := s.store.GetMediaByVideoID(ctx, videoID); err == nil {
			return ResolveResult{SongID: m.SongID, MediaID: m.ID, PrimaryMediaID: m.ID}
		}
	}
	// 2. Canonical hash, if we have both artist and title.
	if title != "" && artistHint != "" {
		hash := CanonicalHash(artistHint, title)
		if sg, err := s.store.GetSongByHash(ctx, hash); err == nil && sg.PrimaryMediaID != "" {
			return ResolveResult{SongID: sg.ID, PrimaryMediaID: sg.PrimaryMediaID}
		}
	}
	// 3. Fuzzy on combined free-text input.
	q := strings.TrimSpace(title)
	if q == "" {
		return ResolveResult{}
	}
	songs, err := s.store.ListSongs(ctx, store.SongFilter{
		Query: q, Status: "ready", Limit: 1,
	})
	if err == nil && len(songs) > 0 && songs[0].PrimaryMediaID != "" {
		return ResolveResult{SongID: songs[0].ID, PrimaryMediaID: songs[0].PrimaryMediaID}
	}
	return ResolveResult{}
}

// =========================================================================
// canonical hashing (mirrors worker/pipeline/hash.py — keep in sync!)
// =========================================================================

var (
	hashPunct  = regexp.MustCompile(`[^\w\s]+`)
	hashWS     = regexp.MustCompile(`\s+`)
	hashParens = regexp.MustCompile(`\([^)]*\)|\[[^\]]*\]`)
)

var hashNoise = map[string]struct{}{
	"official": {}, "video": {}, "audio": {}, "lyrics": {}, "lyric": {},
	"music": {}, "hd": {}, "hq": {}, "remaster": {}, "remastered": {},
	"version": {}, "stereo": {}, "mono": {}, "explicit": {},
}

// Slug normalizes a title/artist into an ASCII slug, mirroring the Python
// implementation. Any divergence here breaks dedup across the two services.
func Slug(s string) string {
	if s == "" {
		return ""
	}
	s = strings.ToValidUTF8(s, "")
	s = hashParens.ReplaceAllString(s, " ")
	s = strings.ToLower(s)
	s = hashPunct.ReplaceAllString(s, " ")
	tokens := []string{}
	for _, t := range hashWS.Split(s, -1) {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if _, ok := hashNoise[t]; ok {
			continue
		}
		tokens = append(tokens, t)
	}
	return strings.Join(tokens, "-")
}

func CanonicalHash(artist, title string) string {
	key := Slug(artist) + "|" + Slug(title)
	h := sha1.Sum([]byte(key))
	return hex.EncodeToString(h[:])
}
