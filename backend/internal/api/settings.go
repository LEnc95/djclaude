package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/lukeencrapera/djclaude/backend/internal/store"
)

// app_settings keys we recognize (typed accessors keep typos out).
const (
	SettingVPSHost           = "deploy.vps_host"
	SettingVPSUser           = "deploy.vps_user"
	SettingVPSPath           = "deploy.vps_path"
	SettingVPSSSHKey         = "deploy.vps_ssh_key"
	SettingVPSRsyncOpts      = "deploy.vps_rsync_opts"
	SettingNotifyEmail       = "notify.email"
	SettingNotifySlack       = "notify.slack_webhook"
	SettingAutoEnqueue       = "library.auto_enqueue_on_fallback"
	SettingWorkerConcurrency = "worker.concurrency"
	// Opaque JSON blob written by the admin /admin player-settings tab.
	// Shape (frontend-defined; backend never validates the contents):
	//   {
	//     "preset": "neon" | "classic" | "concert" | "vaporwave" | "minimal" | "custom",
	//     "fontFamily": "Inter, system-ui",
	//     "fontSize": 64,           // px at 1080p; player scales for phone
	//     "fontWeight": 800,
	//     "fontStyle": "normal" | "italic",
	//     "textColor": "#ffffff",
	//     "activeColor": "#ffe14a", // color for the currently-singing word
	//     "upcomingColor": "#aaaaaa",
	//     "uppercase": true,
	//     "letterSpacing": 1,
	//     "textAlign": "center",
	//     "shadowEnabled": true,
	//     "shadowColor": "auto" | "#000000",  // "auto" → computed contrast color
	//     "shadowOpacity": 0.55,
	//     "shadowBlur": 18,
	//     "bgPanelEnabled": true,    // semi-transparent strip behind the line
	//     "bgPanelOpacity": 0.4
	//   }
	SettingPlayerLyricsStyle = "player.lyrics_style"
)

// settingsResponse is the public, redacted shape; we never leak the SSH key.
type settingsResponse struct {
	VPSHost           string `json:"vps_host"`
	VPSUser           string `json:"vps_user"`
	VPSPath           string `json:"vps_path"`
	VPSSSHKeySet      bool   `json:"vps_ssh_key_set"` // bool only, never the key itself
	VPSRsyncOpts      string `json:"vps_rsync_opts"`
	NotifyEmail       string `json:"notify_email"`
	NotifySlackSet    bool   `json:"notify_slack_set"`
	AutoEnqueue       bool   `json:"auto_enqueue_on_fallback"`
	WorkerConcurrency int    `json:"worker_concurrency"`
	PlayerLyricsStyle json.RawMessage `json:"player_lyrics_style,omitempty"`
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	m, err := s.store.ListSettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := settingsResponse{
		VPSHost:           m[SettingVPSHost],
		VPSUser:           m[SettingVPSUser],
		VPSPath:           m[SettingVPSPath],
		VPSSSHKeySet:      m[SettingVPSSSHKey] != "",
		VPSRsyncOpts:      m[SettingVPSRsyncOpts],
		NotifyEmail:       m[SettingNotifyEmail],
		NotifySlackSet:    m[SettingNotifySlack] != "",
		AutoEnqueue:       m[SettingAutoEnqueue] == "1",
		WorkerConcurrency: parseInt(m[SettingWorkerConcurrency], 1),
	}
	if raw, ok := m[SettingPlayerLyricsStyle]; ok && raw != "" {
		resp.PlayerLyricsStyle = json.RawMessage(raw)
	}
	writeJSON(w, http.StatusOK, resp)
}

// updateSettings: all fields optional; absent = unchanged. Pass an empty
// string to clear a value. SSH key and Slack webhook are write-only.
func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VPSHost           *string         `json:"vps_host"`
		VPSUser           *string         `json:"vps_user"`
		VPSPath           *string         `json:"vps_path"`
		VPSSSHKey         *string         `json:"vps_ssh_key"`
		VPSRsyncOpts      *string         `json:"vps_rsync_opts"`
		NotifyEmail       *string         `json:"notify_email"`
		NotifySlack       *string         `json:"notify_slack_webhook"`
		AutoEnqueue       *bool           `json:"auto_enqueue_on_fallback"`
		WorkerConcurrency *int            `json:"worker_concurrency"`
		PlayerLyricsStyle json.RawMessage `json:"player_lyrics_style,omitempty"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	put := func(key string, val *string) {
		if val == nil {
			return
		}
		if *val == "" {
			_ = s.store.DeleteSetting(r.Context(), key)
			return
		}
		_ = s.store.PutSetting(r.Context(), key, *val)
	}
	put(SettingVPSHost, req.VPSHost)
	put(SettingVPSUser, req.VPSUser)
	put(SettingVPSPath, req.VPSPath)
	put(SettingVPSSSHKey, req.VPSSSHKey)
	put(SettingVPSRsyncOpts, req.VPSRsyncOpts)
	put(SettingNotifyEmail, req.NotifyEmail)
	put(SettingNotifySlack, req.NotifySlack)
	if req.AutoEnqueue != nil {
		v := "0"
		if *req.AutoEnqueue {
			v = "1"
		}
		_ = s.store.PutSetting(r.Context(), SettingAutoEnqueue, v)
	}
	if req.WorkerConcurrency != nil && *req.WorkerConcurrency > 0 {
		_ = s.store.PutSetting(r.Context(), SettingWorkerConcurrency,
			itoa(*req.WorkerConcurrency))
	}
	if len(req.PlayerLyricsStyle) > 0 {
		_ = s.store.PutSetting(r.Context(), SettingPlayerLyricsStyle,
			string(req.PlayerLyricsStyle))
	}
	s.getSettings(w, r)
}

func itoa(n int) string {
	// strconv.Itoa, inlined to avoid an extra import in this file
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	buf := [20]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// settingString returns the stored value or "" if missing/error.
func (s *Server) settingString(r *http.Request, key string) string {
	v, err := s.store.GetSetting(r.Context(), key)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return ""
	}
	return v
}
