// Package store defines the persistence interface used by the API layer.
// The SQLite implementation lives in sqlite.go; swap by writing another
// implementation of Store.
package store

import (
	"context"
	"errors"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrConflict  = errors.New("conflict")
	ErrForbidden = errors.New("forbidden")
)

type RequestFilter struct {
	EventID  string
	Statuses []models.RequestStatus
}

type Store interface {
	CreateEvent(ctx context.Context, e models.Event) error
	GetEventByCode(ctx context.Context, code string) (models.Event, error)
	GetEventByID(ctx context.Context, id string) (models.Event, error)
	UpdateEvent(ctx context.Context, e models.Event) error

	CreateRequest(ctx context.Context, r models.Request) error
	GetRequest(ctx context.Context, id string) (models.Request, error)
	UpdateRequest(ctx context.Context, r models.Request) error
	DeleteRequest(ctx context.Context, id string) error
	ListRequests(ctx context.Context, f RequestFilter) ([]models.Request, error)

	// CountSingerSongs returns the number of requests this singer has had in
	// this event that "consumed a slot" — accepted/singing/done/skipped.
	// Used to assign the rotation index for a new accepted request.
	CountSingerSongs(ctx context.Context, eventID, singerName string) (int, error)

	// CountActiveForSinger returns active (pending/accepted/singing) request
	// count for a singer; used to enforce the per-singer cap.
	CountActiveForSinger(ctx context.Context, eventID, singerName string) (int, error)

	// FindDuplicate returns true if the given video ID already has a non-rejected
	// request in this event (used to flag duplicates for the DJ).
	FindDuplicate(ctx context.Context, eventID, videoID string) (bool, error)

	Close() error
}
