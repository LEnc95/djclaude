package api

import (
	"crypto/rand"
	"encoding/hex"
)

// Unambiguous alphabet — no 0/O/I/1 — for event codes guests have to type.
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func NewEventCode() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	out := make([]byte, 6)
	for i, x := range b {
		out[i] = codeAlphabet[int(x)%len(codeAlphabet)]
	}
	return string(out)
}

func NewID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func NewHostToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
