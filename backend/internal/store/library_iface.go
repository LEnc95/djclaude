package store

import (
	"context"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
)

// LibraryStore — songs, media, request↔song linking.
//
// We keep this as a separate interface so handlers can depend on the narrow
// surface they need, and tests can fake it independently.
type LibraryStore interface {
	CreateSong(ctx context.Context, s models.Song) error
	GetSong(ctx context.Context, id string) (models.Song, error)
	GetSongByHash(ctx context.Context, hash string) (models.Song, error)
	ListSongs(ctx context.Context, f SongFilter) ([]models.Song, error)
	UpdateSongPrimaryMedia(ctx context.Context, songID, mediaID string) error
	DeleteSong(ctx context.Context, id string) error

	GetMedia(ctx context.Context, id string) (models.Media, error)
	GetMediaByVideoID(ctx context.Context, videoID string) (models.Media, error)
	ListMediaForSong(ctx context.Context, songID string) ([]models.Media, error)

	SetRequestSong(ctx context.Context, requestID, songID string) error
	ListPendingRequestsByVideoID(ctx context.Context, videoID string) ([]models.Request, error)
}

// JobStore — processing job queue + import batches.
type JobStore interface {
	CreateJob(ctx context.Context, j models.Job) error
	GetJob(ctx context.Context, id string) (models.Job, error)
	UpdateJob(ctx context.Context, j models.Job) error
	DeleteJob(ctx context.Context, id string) error
	ListJobs(ctx context.Context, f JobFilter) ([]models.Job, error)
	SetJobStatus(ctx context.Context, id string, status models.JobStatus) error
	SetJobPriority(ctx context.Context, id string, priority int) error

	CreateBatch(ctx context.Context, b models.ImportBatch) error
	GetBatch(ctx context.Context, id string) (models.ImportBatch, error)
	ListBatches(ctx context.Context, limit int) ([]models.ImportBatch, error)
}

// AdminStore — admin user + key/value app settings.
type AdminStore interface {
	GetAdminByUsername(ctx context.Context, username string) (models.AdminUser, error)
	GetAdminByID(ctx context.Context, id string) (models.AdminUser, error)
	CreateAdmin(ctx context.Context, u models.AdminUser) error
	UpdateAdminPassword(ctx context.Context, id, newHash string) error
	HasAnyAdmin(ctx context.Context) (bool, error)

	GetSetting(ctx context.Context, key string) (string, error)
	PutSetting(ctx context.Context, key, value string) error
	DeleteSetting(ctx context.Context, key string) error
	ListSettings(ctx context.Context) (map[string]string, error)
}

// FullStore is the concrete superset, implemented by sqliteStore.
// Handlers usually take the narrower interfaces, but the server wiring takes this.
type FullStore interface {
	Store
	LibraryStore
	JobStore
	AdminStore
}
