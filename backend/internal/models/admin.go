package models

import "time"

// AdminUser is the single (currently) operator account. Created on first
// boot with username=admin, password=admin, must_change_password=true.
type AdminUser struct {
	ID                 string    `json:"id"`
	Username           string    `json:"username"`
	PasswordHash       string    `json:"-"` // never serialized
	MustChangePassword bool      `json:"must_change_password"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

// AdminSession is a logged-in admin's bearer token. We don't bother with
// expiry beyond "operator can log out"; this is a single-user self-hosted
// tool. Tokens live in app_settings for simplicity.
type AdminSession struct {
	Token     string    `json:"token"`
	UserID    string    `json:"user_id"`
	CreatedAt time.Time `json:"created_at"`
}
