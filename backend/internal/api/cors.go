package api

import (
	"net/http"
	"strings"
)

// CORS returns a middleware that adds Access-Control-* headers and handles
// OPTIONS preflights. `allowed` is a comma-separated list of origins. The
// special value "*" means "allow any origin" (no credentials). The empty
// string means "no CORS" — pass requests through untouched (suitable for
// same-origin deploys).
//
// Note: the WebSocket endpoint uses gorilla's CheckOrigin which is configured
// separately to accept any origin.
func CORS(allowed string) func(http.Handler) http.Handler {
	allowed = strings.TrimSpace(allowed)
	if allowed == "" {
		return func(next http.Handler) http.Handler { return next }
	}
	wildcard := allowed == "*"
	var list []string
	if !wildcard {
		for _, o := range strings.Split(allowed, ",") {
			o = strings.TrimSpace(o)
			if o != "" {
				list = append(list, strings.TrimRight(o, "/"))
			}
		}
	}
	allowedHeaders := "Content-Type, X-Host-Token, Accept, Origin"

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := strings.TrimRight(r.Header.Get("Origin"), "/")
			if origin != "" {
				if wildcard {
					w.Header().Set("Access-Control-Allow-Origin", "*")
				} else {
					for _, a := range list {
						if a == origin {
							w.Header().Set("Access-Control-Allow-Origin", origin)
							w.Header().Set("Vary", "Origin")
							break
						}
					}
				}
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", allowedHeaders)
				w.Header().Set("Access-Control-Max-Age", "86400")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
