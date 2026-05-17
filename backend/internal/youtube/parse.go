// Package youtube provides best-effort parsing of YouTube URLs into video IDs.
// We never download audio; we only ever persist URL + video ID + metadata.
package youtube

import (
	"net/url"
	"regexp"
	"strings"
)

var idShape = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// ParseVideoID extracts a YouTube video ID from a URL or returns "" if not
// recognizable. Accepts youtube.com/watch?v=ID, youtu.be/ID, /embed/ID,
// /shorts/ID, and raw 11-char IDs.
func ParseVideoID(input string) string {
	s := strings.TrimSpace(input)
	if s == "" {
		return ""
	}
	if idShape.MatchString(s) {
		return s
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Host)
	host = strings.TrimPrefix(host, "www.")
	host = strings.TrimPrefix(host, "m.")

	switch host {
	case "youtu.be":
		id := strings.Trim(u.Path, "/")
		if idShape.MatchString(id) {
			return id
		}
	case "youtube.com", "music.youtube.com":
		if id := u.Query().Get("v"); idShape.MatchString(id) {
			return id
		}
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) >= 2 && (parts[0] == "embed" || parts[0] == "shorts" || parts[0] == "v") {
			if idShape.MatchString(parts[1]) {
				return parts[1]
			}
		}
	}
	return ""
}

// WatchURL builds a canonical watch URL for a video ID.
func WatchURL(videoID string) string {
	if videoID == "" {
		return ""
	}
	return "https://www.youtube.com/watch?v=" + videoID
}

// ThumbnailURL returns YouTube's stable default thumbnail URL for a video.
func ThumbnailURL(videoID string) string {
	if videoID == "" {
		return ""
	}
	return "https://i.ytimg.com/vi/" + videoID + "/hqdefault.jpg"
}
