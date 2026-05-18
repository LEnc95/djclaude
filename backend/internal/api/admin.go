package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
	"github.com/lukeencrapera/djclaude/backend/internal/store"
	"golang.org/x/crypto/bcrypt"
)

const (
	defaultAdminUsername = "admin"
	defaultAdminPassword = "admin"
	adminSessionSetting  = "admin.session.token"
	adminSessionUserSet  = "admin.session.user_id"
)

// EnsureDefaultAdmin creates the admin/admin user on first boot. Forces a
// password change on first successful login.
func EnsureDefaultAdmin(ctx context.Context, st store.AdminStore) error {
	has, err := st.HasAnyAdmin(ctx)
	if err != nil {
		return err
	}
	if has {
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(defaultAdminPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	return st.CreateAdmin(ctx, models.AdminUser{
		ID:                 NewID(),
		Username:           defaultAdminUsername,
		PasswordHash:       string(hash),
		MustChangePassword: true,
		CreatedAt:          now,
		UpdatedAt:          now,
	})
}

// adminLogin issues a session token. Token is stored in app_settings —
// single operator, so we don't need a sessions table.
func (s *Server) adminLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	u, err := s.store.GetAdminByUsername(r.Context(), strings.TrimSpace(req.Username))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(req.Password)) != nil {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	token := randomToken(32)
	_ = s.store.PutSetting(r.Context(), adminSessionSetting, token)
	_ = s.store.PutSetting(r.Context(), adminSessionUserSet, u.ID)

	writeJSON(w, http.StatusOK, map[string]any{
		"token":                token,
		"username":             u.Username,
		"must_change_password": u.MustChangePassword,
	})
}

func (s *Server) adminChangePassword(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAdminUser(w, r)
	if !ok {
		return
	}
	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.NewPassword) < 8 {
		writeError(w, http.StatusBadRequest, "new_password must be at least 8 characters")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(req.CurrentPassword)) != nil {
		writeError(w, http.StatusUnauthorized, "current password is wrong")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.store.UpdateAdminPassword(r.Context(), u.ID, string(hash)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Invalidate the session so the next call requires re-login with the new pw.
	_ = s.store.DeleteSetting(r.Context(), adminSessionSetting)
	_ = s.store.DeleteSetting(r.Context(), adminSessionUserSet)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) adminLogout(w http.ResponseWriter, r *http.Request) {
	_ = s.store.DeleteSetting(r.Context(), adminSessionSetting)
	_ = s.store.DeleteSetting(r.Context(), adminSessionUserSet)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) adminMe(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAdminUser(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// requireAdmin is the middleware used by all /api/admin/* and /api/jobs etc.
func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := s.requireAdminUser(w, r); !ok {
			return
		}
		next(w, r)
	}
}

func (s *Server) requireAdminUser(w http.ResponseWriter, r *http.Request) (models.AdminUser, bool) {
	tok := r.Header.Get("X-Admin-Token")
	if tok == "" {
		tok = r.URL.Query().Get("admin_token")
	}
	if tok == "" {
		writeError(w, http.StatusUnauthorized, "admin token required")
		return models.AdminUser{}, false
	}
	saved, err := s.store.GetSetting(r.Context(), adminSessionSetting)
	if err != nil || saved == "" || saved != tok {
		writeError(w, http.StatusUnauthorized, "invalid admin token")
		return models.AdminUser{}, false
	}
	uid, _ := s.store.GetSetting(r.Context(), adminSessionUserSet)
	if uid == "" {
		writeError(w, http.StatusUnauthorized, "no admin user")
		return models.AdminUser{}, false
	}
	u, err := s.store.GetAdminByID(r.Context(), uid)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "admin user not found")
		return models.AdminUser{}, false
	}
	return u, true
}

func randomToken(nBytes int) string {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		// Crypto rand should never fail; if it does, panic is fine.
		panic(err)
	}
	return hex.EncodeToString(buf)
}
