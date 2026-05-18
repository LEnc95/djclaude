package config

import (
	"os"
	"strconv"
)

type Config struct {
	Addr           string
	DatabasePath   string
	StaticDir      string
	MediaDir       string // root for /media/* file serving
	BaseURL        string
	YouTubeAPIKey  string
	PerSingerLimit int
	AutoAccept     bool
	// AllowedOrigins is a comma-separated list of origins that may call the
	// REST API cross-origin. Empty string means same-origin only (no CORS
	// headers emitted). Set to "*" to allow any origin (no credentials).
	AllowedOrigins string

	// --- worker (Python pipeline service) ---
	WorkerURL   string // e.g. http://localhost:8090
	WorkerToken string // shared secret on /internal/kick + callbacks

	// --- importer / chart credentials (optional) ---
	SpotifyClientID     string
	SpotifyClientSecret string
}

func FromEnv() Config {
	return Config{
		Addr:                env("ADDR", ":8080"),
		DatabasePath:        env("DATABASE_PATH", "karaoke.db"),
		StaticDir:           env("STATIC_DIR", "../frontend/dist"),
		MediaDir:            env("MEDIA_DIR", "./media"),
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
