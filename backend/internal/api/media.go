package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
)

// serveMedia is a byte-range capable static handler for /media/*.
// http.ServeContent handles Range, ETag, If-Modified-Since correctly —
// phones depend on this to seek through the instrumental video.
//
// Path traversal protection: clean the relative path and ensure the resolved
// absolute path is rooted inside cfg.MediaDir.
func (s *Server) serveMedia(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/media/")
	if rel == "" {
		http.NotFound(w, r)
		return
	}
	rel = filepath.Clean(rel)
	if strings.HasPrefix(rel, "..") || strings.ContainsRune(rel, ':') {
		http.NotFound(w, r)
		return
	}
	root, _ := filepath.Abs(s.cfg.MediaDir)
	abs := filepath.Join(root, filepath.FromSlash(rel))
	resolved, _ := filepath.Abs(abs)
	if !strings.HasPrefix(resolved, root+string(filepath.Separator)) && resolved != root {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}
	// Hashed filenames → safe to cache forever.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

func (s *Server) deleteMediaFiles(m models.Media) {
	root, _ := filepath.Abs(s.cfg.MediaDir)
	for _, p := range []string{m.InstrumentalPath, m.LyricsPath, m.ThumbPath} {
		if p == "" {
			continue
		}
		full := filepath.Join(root, filepath.FromSlash(p))
		if strings.HasPrefix(full, root) {
			_ = os.Remove(full)
		}
	}
}
