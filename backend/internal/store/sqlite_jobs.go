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

// =========================================================================
// Jobs
// =========================================================================

func (s *sqliteStore) CreateJob(ctx context.Context, j models.Job) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO jobs (id, song_id, youtube_url, title_hint, artist_hint, year_hint,
		                  priority, status, stage, progress, error, attempts, batch_id,
		                  created_at, started_at, finished_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		j.ID, nullStr(j.SongID), j.YoutubeURL, nullStr(j.TitleHint),
		nullStr(j.ArtistHint), nullInt(j.YearHint), j.Priority, string(j.Status),
		nullStr(j.Stage), j.Progress, nullStr(j.Error), j.Attempts,
		nullStr(j.BatchID), j.CreatedAt, j.StartedAt, j.FinishedAt)
	return err
}

func (s *sqliteStore) GetJob(ctx context.Context, id string) (models.Job, error) {
	row := s.db.QueryRowContext(ctx, jobSelect+` WHERE id = ?`, id)
	return scanJob(row)
}

func (s *sqliteStore) UpdateJob(ctx context.Context, j models.Job) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE jobs SET song_id=?, youtube_url=?, title_hint=?, artist_hint=?, year_hint=?,
		                priority=?, status=?, stage=?, progress=?, error=?, attempts=?,
		                batch_id=?, started_at=?, finished_at=?
		WHERE id=?`,
		nullStr(j.SongID), j.YoutubeURL, nullStr(j.TitleHint), nullStr(j.ArtistHint),
		nullInt(j.YearHint), j.Priority, string(j.Status), nullStr(j.Stage),
		j.Progress, nullStr(j.Error), j.Attempts, nullStr(j.BatchID),
		j.StartedAt, j.FinishedAt, j.ID)
	return err
}

func (s *sqliteStore) DeleteJob(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM jobs WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *sqliteStore) ListJobs(ctx context.Context, f JobFilter) ([]models.Job, error) {
	q := jobSelect + ` WHERE 1=1`
	args := []any{}
	if len(f.Statuses) > 0 {
		placeholders := make([]string, len(f.Statuses))
		for i, st := range f.Statuses {
			placeholders[i] = "?"
			args = append(args, string(st))
		}
		q += ` AND status IN (` + strings.Join(placeholders, ",") + `)`
	}
	if f.BatchID != "" {
		q += ` AND batch_id = ?`
		args = append(args, f.BatchID)
	}
	q += ` ORDER BY priority DESC, created_at ASC`
	if f.Limit > 0 {
		q += fmt.Sprintf(` LIMIT %d`, f.Limit)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Job{}
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// SetJobStatus is a focused mutator the API uses for cancel/retry/priority
// updates. Avoids the read-modify-write round-trip and the small race window
// where the worker might overwrite our change.
func (s *sqliteStore) SetJobStatus(ctx context.Context, id string, status models.JobStatus) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE jobs SET status = ? WHERE id = ?`,
		string(status), id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *sqliteStore) SetJobPriority(ctx context.Context, id string, priority int) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE jobs SET priority = ? WHERE id = ?`, priority, id)
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
// Batches
// =========================================================================

func (s *sqliteStore) CreateBatch(ctx context.Context, b models.ImportBatch) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO import_batches (id, kind, query, total, completed, failed,
		                            notify_email, notify_slack, created_at, finished_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		b.ID, b.Kind, b.Query, b.Total, b.Completed, b.Failed,
		nullStr(b.NotifyEmail), nullStr(b.NotifySlack), b.CreatedAt, b.FinishedAt)
	return err
}

func (s *sqliteStore) GetBatch(ctx context.Context, id string) (models.ImportBatch, error) {
	row := s.db.QueryRowContext(ctx, batchSelect+` WHERE id = ?`, id)
	return scanBatch(row)
}

func (s *sqliteStore) ListBatches(ctx context.Context, limit int) ([]models.ImportBatch, error) {
	q := batchSelect + ` ORDER BY created_at DESC`
	if limit > 0 {
		q += fmt.Sprintf(` LIMIT %d`, limit)
	}
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.ImportBatch{}
	for rows.Next() {
		b, err := scanBatch(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// =========================================================================
// scanners + filters
// =========================================================================

type JobFilter struct {
	Statuses []models.JobStatus
	BatchID  string
	Limit    int
}

const jobSelect = `
	SELECT id, song_id, youtube_url, title_hint, artist_hint, year_hint,
	       priority, status, stage, progress, error, attempts, batch_id,
	       created_at, started_at, finished_at
	FROM jobs`

const batchSelect = `
	SELECT id, kind, query, total, completed, failed, notify_email, notify_slack,
	       created_at, finished_at
	FROM import_batches`

func scanJob(row rowScanner) (models.Job, error) {
	var j models.Job
	var songID, titleHint, artistHint, stage, errStr, batchID sql.NullString
	var year sql.NullInt64
	var status string
	var started, finished sql.NullTime
	err := row.Scan(&j.ID, &songID, &j.YoutubeURL, &titleHint, &artistHint, &year,
		&j.Priority, &status, &stage, &j.Progress, &errStr, &j.Attempts,
		&batchID, &j.CreatedAt, &started, &finished)
	if errors.Is(err, sql.ErrNoRows) {
		return models.Job{}, ErrNotFound
	}
	if err != nil {
		return models.Job{}, err
	}
	j.SongID = songID.String
	j.TitleHint = titleHint.String
	j.ArtistHint = artistHint.String
	j.Stage = stage.String
	j.Error = errStr.String
	j.BatchID = batchID.String
	if year.Valid {
		y := int(year.Int64)
		j.YearHint = &y
	}
	j.Status = models.JobStatus(status)
	if started.Valid {
		t := started.Time
		j.StartedAt = &t
	}
	if finished.Valid {
		t := finished.Time
		j.FinishedAt = &t
	}
	return j, nil
}

func scanBatch(row rowScanner) (models.ImportBatch, error) {
	var b models.ImportBatch
	var email, slack sql.NullString
	var finished sql.NullTime
	err := row.Scan(&b.ID, &b.Kind, &b.Query, &b.Total, &b.Completed, &b.Failed,
		&email, &slack, &b.CreatedAt, &finished)
	if errors.Is(err, sql.ErrNoRows) {
		return models.ImportBatch{}, ErrNotFound
	}
	if err != nil {
		return models.ImportBatch{}, err
	}
	b.NotifyEmail = email.String
	b.NotifySlack = slack.String
	if finished.Valid {
		t := finished.Time
		b.FinishedAt = &t
	}
	return b, nil
}

var _ = time.Now // satisfy linter if unused elsewhere
