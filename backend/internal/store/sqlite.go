package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
	_ "modernc.org/sqlite"
)

type sqliteStore struct {
	db *sql.DB
}

func NewSQLite(path string) (FullStore, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(on)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite — keep it simple, avoid lock contention.
	s := &sqliteStore{db: db}
	if err := s.migrate(); err != nil {
		return nil, err
	}
	if err := s.migrateLibrary(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *sqliteStore) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS events (
			id TEXT PRIMARY KEY,
			code TEXT UNIQUE NOT NULL,
			venue_name TEXT NOT NULL,
			name TEXT NOT NULL,
			status TEXT NOT NULL,
			accepting_requests INTEGER NOT NULL DEFAULT 1,
			auto_accept INTEGER NOT NULL DEFAULT 1,
			per_singer_limit INTEGER NOT NULL DEFAULT 2,
			host_token TEXT NOT NULL,
			starts_at TIMESTAMP,
			ends_at TIMESTAMP,
			created_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS requests (
			id TEXT PRIMARY KEY,
			event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
			singer_name TEXT NOT NULL,
			youtube_url TEXT NOT NULL,
			youtube_video_id TEXT,
			song_title TEXT,
			notes TEXT,
			status TEXT NOT NULL,
			rotation_index INTEGER NOT NULL DEFAULT 1,
			manual_order INTEGER NOT NULL DEFAULT 0,
			is_duplicate INTEGER NOT NULL DEFAULT 0,
			guest_id TEXT,
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_requests_event ON requests(event_id, status)`,
		`CREATE INDEX IF NOT EXISTS idx_requests_singer ON requests(event_id, singer_name COLLATE NOCASE)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	return nil
}

func (s *sqliteStore) Close() error { return s.db.Close() }

// ---- events ----

func (s *sqliteStore) CreateEvent(ctx context.Context, e models.Event) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO events (id, code, venue_name, name, status, accepting_requests, auto_accept,
		                    per_singer_limit, host_token, starts_at, ends_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.ID, e.Code, e.VenueName, e.Name, string(e.Status), boolInt(e.AcceptingRequests),
		boolInt(e.AutoAccept), e.PerSingerLimit, e.HostToken, e.StartsAt, e.EndsAt, e.CreatedAt)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return ErrConflict
	}
	return err
}

func (s *sqliteStore) GetEventByCode(ctx context.Context, code string) (models.Event, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, code, venue_name, name, status, accepting_requests, auto_accept,
		       per_singer_limit, host_token, starts_at, ends_at, created_at
		FROM events WHERE code = ? COLLATE NOCASE`, code)
	var e models.Event
	var status string
	var acc, auto int
	var starts, ends sql.NullTime
	err := row.Scan(&e.ID, &e.Code, &e.VenueName, &e.Name, &status, &acc, &auto,
		&e.PerSingerLimit, &e.HostToken, &starts, &ends, &e.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return models.Event{}, ErrNotFound
	}
	if err != nil {
		return models.Event{}, err
	}
	e.Status = models.EventStatus(status)
	e.AcceptingRequests = acc == 1
	e.AutoAccept = auto == 1
	if starts.Valid {
		t := starts.Time
		e.StartsAt = &t
	}
	if ends.Valid {
		t := ends.Time
		e.EndsAt = &t
	}
	return e, nil
}

func (s *sqliteStore) GetEventByID(ctx context.Context, id string) (models.Event, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, code, venue_name, name, status, accepting_requests, auto_accept,
		       per_singer_limit, host_token, starts_at, ends_at, created_at
		FROM events WHERE id = ?`, id)
	var e models.Event
	var status string
	var acc, auto int
	var starts, ends sql.NullTime
	err := row.Scan(&e.ID, &e.Code, &e.VenueName, &e.Name, &status, &acc, &auto,
		&e.PerSingerLimit, &e.HostToken, &starts, &ends, &e.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return models.Event{}, ErrNotFound
	}
	if err != nil {
		return models.Event{}, err
	}
	e.Status = models.EventStatus(status)
	e.AcceptingRequests = acc == 1
	e.AutoAccept = auto == 1
	if starts.Valid {
		t := starts.Time
		e.StartsAt = &t
	}
	if ends.Valid {
		t := ends.Time
		e.EndsAt = &t
	}
	return e, nil
}

func (s *sqliteStore) UpdateEvent(ctx context.Context, e models.Event) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE events SET venue_name=?, name=?, status=?, accepting_requests=?,
		                  auto_accept=?, per_singer_limit=?, starts_at=?, ends_at=?
		WHERE id=?`,
		e.VenueName, e.Name, string(e.Status), boolInt(e.AcceptingRequests),
		boolInt(e.AutoAccept), e.PerSingerLimit, e.StartsAt, e.EndsAt, e.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- requests ----

func (s *sqliteStore) CreateRequest(ctx context.Context, r models.Request) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO requests (id, event_id, singer_name, youtube_url, youtube_video_id, song_title,
		                      song_id, notes, status, rotation_index, manual_order, is_duplicate,
		                      guest_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.EventID, r.SingerName, r.YoutubeURL, nullStr(r.YoutubeVideoID),
		nullStr(r.SongTitle), nullStr(r.SongID), nullStr(r.Notes), string(r.Status),
		r.RotationIndex, r.ManualOrder, boolInt(r.IsDuplicate), nullStr(r.GuestID),
		r.CreatedAt, r.UpdatedAt)
	return err
}

func (s *sqliteStore) GetRequest(ctx context.Context, id string) (models.Request, error) {
	row := s.db.QueryRowContext(ctx, requestSelect+` WHERE id = ?`, id)
	return scanRequest(row)
}

func (s *sqliteStore) UpdateRequest(ctx context.Context, r models.Request) error {
	r.UpdatedAt = time.Now().UTC()
	res, err := s.db.ExecContext(ctx, `
		UPDATE requests SET singer_name=?, youtube_url=?, youtube_video_id=?, song_title=?,
		                    song_id=?, notes=?, status=?, rotation_index=?, manual_order=?,
		                    is_duplicate=?, updated_at=?
		WHERE id=?`,
		r.SingerName, r.YoutubeURL, nullStr(r.YoutubeVideoID), nullStr(r.SongTitle),
		nullStr(r.SongID), nullStr(r.Notes), string(r.Status), r.RotationIndex,
		r.ManualOrder, boolInt(r.IsDuplicate), r.UpdatedAt, r.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *sqliteStore) DeleteRequest(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM requests WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *sqliteStore) ListRequests(ctx context.Context, f RequestFilter) ([]models.Request, error) {
	q := requestSelect + ` WHERE event_id = ?`
	args := []any{f.EventID}
	if len(f.Statuses) > 0 {
		placeholders := make([]string, len(f.Statuses))
		for i, st := range f.Statuses {
			placeholders[i] = "?"
			args = append(args, string(st))
		}
		q += ` AND status IN (` + strings.Join(placeholders, ",") + `)`
	}
	// Order: manual_order first (DJ overrides), then rotation_index, then created_at.
	q += ` ORDER BY
		CASE WHEN manual_order > 0 THEN 0 ELSE 1 END,
		manual_order ASC,
		rotation_index ASC,
		created_at ASC`
	rows, err := s.db.QueryContext(ctx, q, args...)
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

func (s *sqliteStore) CountSingerSongs(ctx context.Context, eventID, singer string) (int, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM requests
		WHERE event_id = ? AND singer_name = ? COLLATE NOCASE
		  AND status IN ('accepted','singing','done','skipped')`,
		eventID, singer)
	var n int
	err := row.Scan(&n)
	return n, err
}

func (s *sqliteStore) CountActiveForSinger(ctx context.Context, eventID, singer string) (int, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM requests
		WHERE event_id = ? AND singer_name = ? COLLATE NOCASE
		  AND status IN ('pending','accepted','singing')`,
		eventID, singer)
	var n int
	err := row.Scan(&n)
	return n, err
}

func (s *sqliteStore) FindDuplicate(ctx context.Context, eventID, videoID string) (bool, error) {
	if videoID == "" {
		return false, nil
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM requests
		WHERE event_id = ? AND youtube_video_id = ? AND status != 'rejected'`,
		eventID, videoID)
	var n int
	if err := row.Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// ---- helpers ----

const requestSelect = `
	SELECT id, event_id, singer_name, youtube_url, youtube_video_id, song_title, song_id,
	       notes, status, rotation_index, manual_order, is_duplicate, guest_id,
	       created_at, updated_at
	FROM requests`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanRequest(row rowScanner) (models.Request, error) {
	var r models.Request
	var vid, title, songID, notes, guestID sql.NullString
	var dup int
	var status string
	err := row.Scan(&r.ID, &r.EventID, &r.SingerName, &r.YoutubeURL, &vid, &title, &songID,
		&notes, &status, &r.RotationIndex, &r.ManualOrder, &dup, &guestID,
		&r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return models.Request{}, ErrNotFound
	}
	if err != nil {
		return models.Request{}, err
	}
	r.YoutubeVideoID = vid.String
	r.SongTitle = title.String
	r.SongID = songID.String
	r.Notes = notes.String
	r.GuestID = guestID.String
	r.IsDuplicate = dup == 1
	r.Status = models.RequestStatus(status)
	return r, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
