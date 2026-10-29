package relay

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// PalworldStatus is the public-status subset of Palworld's REST API:
// GET /v1/api/info (version, server name) and GET /v1/api/metrics (players,
// server FPS, uptime, in-game days). Both need the admin password.
type PalworldStatus struct {
	Name          string
	Version       string
	Players       int
	MaxPlayers    int
	ServerFPS     float64
	UptimeSeconds int64
	Days          int
}

// QueryPalworldStatus reads info and metrics. host must be a vetted, pinned
// IP literal; opts carries the name and TLS flag exactly as connectGame does.
func QueryPalworldStatus(host string, port int, password string, opts dialOptions) (PalworldStatus, error) {
	c := newPalworldRest(host, port, password, opts)
	defer c.Close()

	infoRaw, err := c.request(http.MethodGet, "/info", nil)
	if err != nil {
		return PalworldStatus{}, err
	}
	metricsRaw, err := c.request(http.MethodGet, "/metrics", nil)
	if err != nil {
		return PalworldStatus{}, err
	}
	return parsePalworldStatus(infoRaw, metricsRaw)
}

func parsePalworldStatus(infoRaw, metricsRaw string) (PalworldStatus, error) {
	var info struct {
		Version    string `json:"version"`
		ServerName string `json:"servername"`
	}
	var metrics struct {
		CurrentPlayers *int    `json:"currentplayernum"`
		MaxPlayers     int     `json:"maxplayernum"`
		ServerFPS      float64 `json:"serverfps"`
		Uptime         int64   `json:"uptime"`
		Days           int     `json:"days"`
	}
	if err := json.Unmarshal([]byte(infoRaw), &info); err != nil {
		return PalworldStatus{}, fmt.Errorf("palworld REST API: unexpected info response")
	}
	if err := json.Unmarshal([]byte(metricsRaw), &metrics); err != nil || metrics.CurrentPlayers == nil {
		return PalworldStatus{}, fmt.Errorf("palworld REST API: unexpected metrics response")
	}
	return PalworldStatus{
		Name:          cleanText(info.ServerName, 128),
		Version:       cleanText(info.Version, 64),
		Players:       *metrics.CurrentPlayers,
		MaxPlayers:    metrics.MaxPlayers,
		ServerFPS:     metrics.ServerFPS,
		UptimeSeconds: metrics.Uptime,
		Days:          metrics.Days,
	}, nil
}
