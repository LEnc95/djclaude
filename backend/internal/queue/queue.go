// Package queue holds the fairness rules and ordering helpers for the
// karaoke request queue. Two design notes:
//
//  1. Each accepted request carries a rotation_index = "this singer's nth song
//     this event" (counting active + already-sung). Sorting the queue by
//     (manual_order, rotation_index, created_at) naturally interleaves singers
//     so no one hogs the rotation.
//
//  2. Per-singer cap limits how many active (pending/accepted/singing)
//     requests one name can stack up at a time. Configurable per event.
package queue

import (
	"context"
	"errors"

	"github.com/lukeencrapera/djclaude/backend/internal/models"
	"github.com/lukeencrapera/djclaude/backend/internal/store"
)

var (
	ErrSingerLimitReached = errors.New("singer has too many active requests")
	ErrNotAccepting       = errors.New("event is not accepting requests")
	ErrEventClosed        = errors.New("event is closed")
)

// AssignRotationIndex sets r.RotationIndex based on how many songs this singer
// has already had a slot for in this event.
func AssignRotationIndex(ctx context.Context, st store.Store, r *models.Request) error {
	n, err := st.CountSingerSongs(ctx, r.EventID, r.SingerName)
	if err != nil {
		return err
	}
	r.RotationIndex = n + 1
	return nil
}

// EnforceCap returns ErrSingerLimitReached if adding another active request
// for this singer would exceed the event's per-singer limit.
func EnforceCap(ctx context.Context, st store.Store, eventID, singer string, limit int) error {
	if limit <= 0 {
		return nil
	}
	n, err := st.CountActiveForSinger(ctx, eventID, singer)
	if err != nil {
		return err
	}
	if n >= limit {
		return ErrSingerLimitReached
	}
	return nil
}

// EstimatePosition returns the 1-indexed position of the given request id
// within the upcoming queue (accepted + singing), or 0 if it's not queued.
func EstimatePosition(reqs []models.Request, id string) int {
	pos := 0
	for _, r := range reqs {
		if r.Status == models.StatusAccepted || r.Status == models.StatusSinging {
			pos++
			if r.ID == id {
				return pos
			}
		}
	}
	return 0
}
