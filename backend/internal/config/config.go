package config

import (
	"os"
	"strconv"
)

type Config struct {
	Addr           string
	DatabasePath   string
	StaticDir      string
	BaseURL        string
	YouTubeAPIKey  string
	PerSingerLimit int
	AutoAccept     bool
	// AllowedOrigins is a comma-separated list of origins that may call the
	// REST API cross-origin. Empty string means same-origin only (no CORS
	// headers emitted). Set to "*" to allow any origin (no credentials).
	AllowedOrigins string
}

func FromEnv() Config {
	return Config{
		Addr:           env("ADDR", ":8080"),
		DatabasePath:   env("DATABASE_PATH", "karaoke.db"),
		StaticDir:      env("STATIC_DIR", "../frontend/dist"),
		BaseURL:        env("BASE_URL", "http://localhost:8080"),
		YouTubeAPIKey:  env("YOUTUBE_API_KEY", ""),
		PerSingerLimit: envInt("PER_SINGER_LIMIT", 2),
		AutoAccept:     envBool("AUTO_ACCEPT", true),
		AllowedOrigins: env("ALLOWED_ORIGINS", ""),
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
