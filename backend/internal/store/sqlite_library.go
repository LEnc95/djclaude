package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
)

// migrateLibrary runs the additive migrations for the library/jobs/admin
// schema. Called from NewSQLite after the v1 migrate(). Idempotent.
func (s *sqliteStore) migrateLibrary() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS songs (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			artist TEXT NOT NULL,
			year INTEGER,
			duration_sec INTEGER,
			canonical_hash TEXT NOT NULL UNIQUE,
			primary_media_id TEXT,
			status TEXT NOT NULL,
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist COLLATE NOCASE)`,
		`CREATE INDEX IF NOT EXISTS idx_songs_year ON songs(year)`,
		`CREATE INDEX IF NOT EXISTS idx_songs_status ON songs(status)`,

		`CREATE TABLE IF NOT EXISTS media (
			id TEXT PRIMARY KEY,
			song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
			source_url TEXT NOT NULL,
			source_video_id TEXT,
			instrumental_path TEXT NOT NULL,
			lyrics_path TEXT NOT NULL,
			thumb_path TEXT,
			bytes INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_media_song ON media(song_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_media_video ON media(source_video_id)
		    WHERE source_video_id IS NOT NULL`,

		`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY,
			song_id TEXT REFERENCES songs(id) ON DELETE SET NULL,
			youtube_url TEXT NOT NULL,
			title_hint TEXT,
			artist_hint TEXT,
			year_hint INTEGER,
			priority INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			stage TEXT,
			progress REAL NOT NULL DEFAULT 0,
			error TEXT,
			attempts INTEGER NOT NULL DEFAULT 0,
			batch_id TEXT,
			created_at TIMESTAMP NOT NULL,
			started_at TIMESTAMP,
			finished_at TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority DESC, created_at ASC)`,
		`CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id)`,

		`CREATE TABLE IF NOT EXISTS import_batches (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			query TEXT NOT NULL,
			total INTEGER NOT NULL DEFAULT 0,
			completed INTEGER NOT NULL DEFAULT 0,
			failed INTEGER NOT NULL DEFAULT 0,
			notify_email TEXT,
			notify_slack TEXT,
			created_at TIMESTAMP NOT NULL,
			finished_at TIMESTAMP
		)`,

		`CREATE TABLE IF NOT EXISTS app_settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TIMESTAMP NOT NULL
		)`,

		`CREATE TABLE IF NOT EXISTS admin_users (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL UNIQUE COLLATE NOCASE,
			password_hash TEXT NOT NULL,
			must_change_password INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL
		)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrateLibrary: %w", err)
		}
	}
	// ALTER TABLE doesn't have IF NOT EXISTS; guard with PRAGMA introspection.
	if err := s.addColumnIfMissing("requests", "song_id", "TEXT REFERENCES songs(id) ON DELETE SET NULL"); err != nil {
		return err
	}
	if _, err := s.db.Exec(`CREATE INDEX IF NOT EXISTS idx_requests_song ON requests(song_id)`); err != nil {
		return fmt.Errorf("migrateLibrary index requests.song_id: %w", err)
	}
	return nil
}

func (s *sqliteStore) addColumnIfMissing(table, column, decl string) error {
	rows, err := s.db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if strings.EqualFold(name, column) {
			return nil
		}
	}
	_, err = s.db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + decl)
	return err
}

// =========================================================================
// Songs
// =========================================================================

func (s *sqliteStore) CreateSong(ctx context.Context, sg models.Song) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO songs (id, title, artist, year, duration_sec, canonical_hash,
		                   primary_media_id, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sg.ID, sg.Title, sg.Artist, nullInt(sg.Year), sg.DurationSec,
		sg.CanonicalHash, nullStr(sg.PrimaryMediaID), string(sg.Status),
		sg.CreatedAt, sg.UpdatedAt)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return ErrConflict
	}
	return err
}

func (s *sqliteStore) GetSong(ctx context.Context, id string) (models.Song, error) {
	row := s.db.QueryRowContext(ctx, songSelect+` WHERE id = ?`, id)
	return scanSong(row)
}

func (s *sqliteStore) GetSongByHash(ctx context.Context, hash string) (models.Song, error) {
	row := s.db.QueryRowContext(ctx, songSelect+` WHERE canonical_hash = ?`, hash)
	return scanSong(row)
}

func (s *sqliteStore) ListSongs(ctx context.Context, f SongFilter) ([]models.Song, error) {
	q := songSelect + ` WHERE 1=1`
	args := []any{}
	if f.Query != "" {
		q += ` AND (title LIKE ? OR artist LIKE ?)`
		like := "%" + f.Query + "%"
		args = append(args, like, like)
	}
	if f.Artist != "" {
		q += ` AND artist = ? COLLATE NOCASE`
		args = append(args, f.Artist)
	}
	if f.Year != nil {
		q += ` AND year = ?`
		args = append(args, *f.Year)
	}
	if f.Status != "" {
		q += ` AND status = ?`
		args = append(args, string(f.Status))
	}
	q += ` ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE`
	if f.Limit > 0 {
		q += fmt.Sprintf(` LIMIT %d`, f.Limit)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Song{}
	for rows.Next() {
		sg, err := scanSong(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sg)
	}
	return out, rows.Err()
}

func (s *sqliteStore) UpdateSongPrimaryMedia(ctx context.Context, songID, mediaID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE songs SET primary_media_id = ?, status = 'ready', updated_at = ?
		WHERE id = ?`, mediaID, time.Now().UTC(), songID)
	return err
}

func (s *sqliteStore) DeleteSong(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM songs WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// =========================================================================
// Media
// =========================================================================

func (s *sqliteStore) GetMedia(ctx context.Context, id string) (models.Media, error) {
	row := s.db.QueryRowContext(ctx, mediaSelect+` WHERE id = ?`, id)
	return scanMedia(row)
}

func (s *sqliteStore) GetMediaByVideoID(ctx context.Context, videoID string) (models.Media, error) {
	if videoID == "" {
		return models.Media{}, ErrNotFound
	}
	row := s.db.QueryRowContext(ctx, mediaSelect+` WHERE source_video_id = ?`, videoID)
	return scanMedia(row)
}

func (s *sqliteStore) ListMediaForSong(ctx context.Context, songID string) ([]models.Media, error) {
	rows, err := s.db.QueryContext(ctx, mediaSelect+` WHERE song_id = ? ORDER BY created_at DESC`, songID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Media{}
	for rows.Next() {
		m, err := scanMedia(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// =========================================================================
// Linking requests → songs (used by createRequest resolver)
// =========================================================================

func (s *sqliteStore) SetRequestSong(ctx context.Context, requestID, songID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE requests SET song_id = ?, updated_at = ? WHERE id = ?`,
		songID, time.Now().UTC(), requestID)
	return err
}

// =========================================================================
// scanners + filters
// =========================================================================

type SongFilter struct {
	Query  string
	Artist string
	Year   *int
	Status models.SongStatus
	Limit  int
}

const songSelect = `
	SELECT id, title, artist, year, duration_sec, canonical_hash,
	       primary_media_id, status, created_at, updated_at
	FROM songs`

const mediaSelect = `
	SELECT id, song_id, source_url, source_video_id, instrumental_path,
	       lyrics_path, thumb_path, bytes, created_at
	FROM media`

func scanSong(row rowScanner) (models.Song, error) {
	var sg models.Song
	var year sql.NullInt64
	var primary sql.NullString
	var status string
	err := row.Scan(&sg.ID, &sg.Title, &sg.Artist, &year, &sg.DurationSec,
		&sg.CanonicalHash, &primary, &status, &sg.CreatedAt, &sg.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return models.Song{}, ErrNotFound
	}
	if err != nil {
		return models.Song{}, err
	}
	if year.Valid {
		y := int(year.Int64)
		sg.Year = &y
	}
	sg.PrimaryMediaID = primary.String
	sg.Status = models.SongStatus(status)
	return sg, nil
}

func scanMedia(row rowScanner) (models.Media, error) {
	var m models.Media
	var vid, thumb sql.NullString
	err := row.Scan(&m.ID, &m.SongID, &m.SourceURL, &vid,
		&m.InstrumentalPath, &m.LyricsPath, &thumb, &m.Bytes, &m.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return models.Media{}, ErrNotFound
	}
	if err != nil {
		return models.Media{}, err
	}
	m.SourceVideoID = vid.String
	m.ThumbPath = thumb.String
	return m, nil
}

func nullInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}
