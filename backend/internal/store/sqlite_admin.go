package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
)

// =========================================================================
// Admin users + settings (single-row k/v)
// =========================================================================

func (s *sqliteStore) GetAdminByID(ctx context.Context, id string) (models.AdminUser, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, must_change_password, created_at, updated_at
		 FROM admin_users WHERE id = ?`, id)
	var u models.AdminUser
	var must int
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &must, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return models.AdminUser{}, ErrNotFound
	}
	if err != nil {
		return models.AdminUser{}, err
	}
	u.MustChangePassword = must == 1
	return u, nil
}

// ListPendingRequestsByVideoID — used by the job-completion hook to attach
// the new song_id to every open request that asked for this video before
// processing finished.
func (s *sqliteStore) ListPendingRequestsByVideoID(ctx context.Context, videoID string) ([]models.Request, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, event_id, singer_name, youtube_url, youtube_video_id, song_title,
		        notes, status, rotation_index, manual_order, is_duplicate, guest_id,
		        created_at, updated_at
		 FROM requests WHERE song_id IS NULL AND youtube_video_id = ?
		   AND status IN ('pending','accepted','singing')`, videoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Request{}
	for rows.Next() {
		r, err := scanRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *sqliteStore) GetAdminByUsername(ctx context.Context, username string) (models.AdminUser, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, must_change_password, created_at, updated_at
		 FROM admin_users WHERE username = ? COLLATE NOCASE`, username)
	var u models.AdminUser
	var must int
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &must, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return models.AdminUser{}, ErrNotFound
	}
	if err != nil {
		return models.AdminUser{}, err
	}
	u.MustChangePassword = must == 1
	return u, nil
}

func (s *sqliteStore) CreateAdmin(ctx context.Context, u models.AdminUser) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO admin_users (id, username, password_hash, must_change_password, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.PasswordHash, boolInt(u.MustChangePassword),
		u.CreatedAt, u.UpdatedAt)
	return err
}

func (s *sqliteStore) UpdateAdminPassword(ctx context.Context, id, newHash string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE admin_users
		SET password_hash = ?, must_change_password = 0, updated_at = ?
		WHERE id = ?`, newHash, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *sqliteStore) HasAnyAdmin(ctx context.Context) (bool, error) {
	row := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM admin_users`)
	var n int
	if err := row.Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// =========================================================================
// app_settings is a tiny key/value store. We use it for the admin session
// token (single operator), VPS deploy config, importer prefs, etc.
// =========================================================================

func (s *sqliteStore) GetSetting(ctx context.Context, key string) (string, error) {
	row := s.db.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = ?`, key)
	var v string
	err := row.Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return v, err
}

func (s *sqliteStore) PutSetting(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, value, time.Now().UTC())
	return err
}

func (s *sqliteStore) DeleteSetting(ctx context.Context, key string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM app_settings WHERE key = ?`, key)
	return err
}

func (s *sqliteStore) ListSettings(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM app_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}
