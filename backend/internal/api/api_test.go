package api

import "testing"

func TestNormalizeRequestSongUsesPlainTextAsTitle(t *testing.T) {
	url, videoID, title := normalizeRequestSong("Mr. Brightside", "")

	if url != "" {
		t.Fatalf("url = %q, want empty", url)
	}
	if videoID != "" {
		t.Fatalf("videoID = %q, want empty", videoID)
	}
	if title != "Mr. Brightside" {
		t.Fatalf("title = %q, want %q", title, "Mr. Brightside")
	}
}

func TestNormalizeRequestSongCanonicalizesYouTubeURL(t *testing.T) {
	url, videoID, title := normalizeRequestSong("https://youtu.be/dQw4w9WgXcQ", "Never Gonna Give You Up")

	if url != "https://www.youtube.com/watch?v=dQw4w9WgXcQ" {
		t.Fatalf("url = %q", url)
	}
	if videoID != "dQw4w9WgXcQ" {
		t.Fatalf("videoID = %q", videoID)
	}
	if title != "Never Gonna Give You Up" {
		t.Fatalf("title = %q", title)
	}
}
