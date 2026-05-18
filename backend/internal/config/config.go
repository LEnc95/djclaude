package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	// Resolved absolute paths — never relative. Anchored to the project root
	// (the directory containing .env, auto-discovered). This means both the
	// Go server and the Python worker hit the same files no matter which
	// directory either process is launched from.
	Addr           string
	DatabasePath   string
	StaticDir      string
	MediaDir       string
	BaseURL        string
	YouTubeAPIKey  string
	PerSingerLimit int
	AutoAccept     bool
	AllowedOrigins string

	// Worker
	WorkerURL   string
	WorkerToken string

	// Importers
	SpotifyClientID     string
	SpotifyClientSecret string

	// Project root — exposed in case other code needs to anchor against it.
	ProjectRoot string
}

func FromEnv() Config {
	root := findProjectRoot()
	loadDotEnv(filepath.Join(root, ".env"))

	cfg := Config{
		ProjectRoot:         root,
		Addr:                env("ADDR", ":8080"),
		DatabasePath:        resolveUnder(root, env("DATABASE_PATH", "karaoke.db")),
		StaticDir:           resolveUnder(root, env("STATIC_DIR", "frontend/dist")),
		MediaDir:            resolveUnder(root, env("MEDIA_DIR", "media")),
		BaseURL:             env("BASE_URL", "http://localhost:8080"),
		YouTubeAPIKey:       env("YOUTUBE_API_KEY", ""),
		PerSingerLimit:      envInt("PER_SINGER_LIMIT", 2),
		AutoAccept:          envBool("AUTO_ACCEPT", true),
		AllowedOrigins:      env("ALLOWED_ORIGINS", ""),
		WorkerURL:           env("WORKER_URL", "http://localhost:8090"),
		WorkerToken:         env("WORKER_TOKEN", "change-me-shared-secret"),
		SpotifyClientID:     env("SPOTIFY_CLIENT_ID", ""),
		SpotifyClientSecret: env("SPOTIFY_CLIENT_SECRET", ""),
	}
	return cfg
}

// findProjectRoot walks upward from cwd until it finds a `.env` file or
// a `go.mod` file (a stable marker that we're inside the repo). Returns
// cwd if neither is found — degrades cleanly.
func findProjectRoot() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	dir := cwd
	for {
		// .env at this level wins immediately
		if _, err := os.Stat(filepath.Join(dir, ".env")); err == nil {
			return dir
		}
		// go.mod marker — but only accept if the parent looks like our
		// repo (has a worker/ sibling). Otherwise we're inside backend/.
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			parent := filepath.Dir(dir)
			if _, err := os.Stat(filepath.Join(parent, "worker")); err == nil {
				return parent
			}
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return cwd
		}
		dir = parent
	}
}

// resolveUnder turns a relative path into an absolute path anchored at root.
// Absolute paths are returned unchanged so explicit overrides still work.
func resolveUnder(root, p string) string {
	if p == "" {
		return ""
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Clean(filepath.Join(root, p))
}

// loadDotEnv is a tiny KEY=VAL parser. We avoid the godotenv dependency
// because the syntax we need is trivial: no shell expansion, no multiline,
// just KEY=VAL with # comments and optional surrounding quotes. Any env
// var already set wins over the .env value (12-factor convention).
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		// Strip a trailing inline comment unless it's inside quotes.
		if !strings.HasPrefix(val, `"`) && !strings.HasPrefix(val, `'`) {
			if hash := strings.IndexByte(val, '#'); hash >= 0 {
				val = strings.TrimSpace(val[:hash])
			}
		}
		// Strip matching surrounding quotes.
		if len(val) >= 2 {
			if (val[0] == '"' && val[len(val)-1] == '"') ||
				(val[0] == '\'' && val[len(val)-1] == '\'') {
				val = val[1 : len(val)-1]
			}
		}
		if key == "" {
			continue
		}
		// Don't clobber values already in the environment.
		if _, set := os.LookupEnv(key); set {
			continue
		}
		_ = os.Setenv(key, val)
	}
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, ok := os.LookupEnv(k); ok {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return def
}

func envBool(k string, def bool) bool {
	if v, ok := os.LookupEnv(k); ok {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}
