package api

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"regexp"
	"strings"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
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

	// 2. Split "Artist - Title" (what the guest autocomplete fills in) and
	//    try canonical hashing each ordering. Catches the common case where
	//    no explicit artistHint was given but the input string already
	//    encodes both fields with a separator.
	if artistHint == "" && strings.Contains(title, " - ") {
		parts := strings.SplitN(title, " - ", 2)
		if len(parts) == 2 {
			left, right := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
			for _, pair := range [][2]string{{left, right}, {right, left}} {
				hash := CanonicalHash(pair[0], pair[1])
				if sg, err := s.store.GetSongByHash(ctx, hash); err == nil && sg.PrimaryMediaID != "" {
					return ResolveResult{SongID: sg.ID, PrimaryMediaID: sg.PrimaryMediaID}
				}
			}
		}
	}

	// 3. Canonical hash with an explicit artist hint (admin/API-driven submission).
	if title != "" && artistHint != "" {
		hash := CanonicalHash(artistHint, title)
		if sg, err := s.store.GetSongByHash(ctx, hash); err == nil && sg.PrimaryMediaID != "" {
			return ResolveResult{SongID: sg.ID, PrimaryMediaID: sg.PrimaryMediaID}
		}
	}

	// 4. Fuzzy: ALL-WORDS match on title+artist. We tokenize the query and
	//    require every token to appear in either title or artist. That way
	//    "Acoustic Lounge - Alanis Morissette" matches a song whose artist
	//    is "Acoustic Lounge" and title is "Alanis Morissette" even though
	//    no single field contains the whole literal string.
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

	// 5. All-tokens-anywhere fallback: split q into words, look for songs
	//    where every word appears in (title || artist).
	tokens := splitTokens(q)
	if len(tokens) >= 2 {
		if sg := s.findByAllTokens(ctx, tokens); sg != nil && sg.PrimaryMediaID != "" {
			return ResolveResult{SongID: sg.ID, PrimaryMediaID: sg.PrimaryMediaID}
		}
	}
	return ResolveResult{}
}

// splitTokens lowercases + strips punctuation + drops short noise.
func splitTokens(s string) []string {
	s = strings.ToLower(s)
	s = hashPunct.ReplaceAllString(s, " ")
	out := []string{}
	for _, w := range hashWS.Split(s, -1) {
		w = strings.TrimSpace(w)
		if len(w) >= 3 { // drop "of", "to", "a"
			out = append(out, w)
		}
	}
	return out
}

// findByAllTokens iterates the small ready library checking each row for
// "every token must appear in title or artist (case-insensitive)". For
// realistic libraries (hundreds-low-thousands of songs) this is fine; if
// the library grows huge we'd promote it to an FTS5 virtual table.
func (s *Server) findByAllTokens(ctx context.Context, tokens []string) *models.Song {
	songs, err := s.store.ListSongs(ctx, store.SongFilter{Status: "ready", Limit: 5000})
	if err != nil {
		return nil
	}
	for i := range songs {
		hay := strings.ToLower(songs[i].Title + " " + songs[i].Artist)
		all := true
		for _, t := range tokens {
			if !strings.Contains(hay, t) {
				all = false
				break
			}
		}
		if all {
			return &songs[i]
		}
	}
	return nil
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
