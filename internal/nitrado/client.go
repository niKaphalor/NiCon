// Package nitrado is a minimal client for the parts of the Nitrado API NiCon
// needs: listing a user's services and checking whether each one's game
// currently has RCON enabled.
package nitrado

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

const baseURL = "https://api.nitrado.net"

type Client struct {
	token      string
	httpClient *http.Client
}

func NewClient(token string) *Client {
	return &Client{token: token, httpClient: &http.Client{}}
}

type apiEnvelope struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data"`
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request %s: %w", path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("nitrado API token is invalid or expired")
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d from %s", resp.StatusCode, path)
	}

	var env apiEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return fmt.Errorf("decode response from %s: %w", path, err)
	}
	if env.Status != "success" {
		return fmt.Errorf("nitrado reported an error for %s", path)
	}
	return json.Unmarshal(env.Data, out)
}

// Service is one entry from GET /services.
type Service struct {
	ID     int    `json:"id"`
	Status string `json:"status"`
}

func (c *Client) ListServices(ctx context.Context) ([]Service, error) {
	var data struct {
		Services []Service `json:"services"`
	}
	if err := c.get(ctx, "/services", &data); err != nil {
		return nil, err
	}
	return data.Services, nil
}

// Gameserver is the subset of GET /services/{id}/gameservers NiCon needs.
type Gameserver struct {
	Status    string `json:"status"`
	IP        string `json:"ip"`
	RconPort  int    `json:"rcon_port"`
	GameHuman string `json:"game_human"`
	Query     struct {
		ServerName string `json:"server_name"`
	} `json:"query"`
	GameSpecific struct {
		Features struct {
			HasRcon bool `json:"has_rcon"`
		} `json:"features"`
	} `json:"game_specific"`
}

func (c *Client) GetGameserver(ctx context.Context, serviceID int) (Gameserver, error) {
	var data struct {
		Gameserver Gameserver `json:"gameserver"`
	}
	if err := c.get(ctx, fmt.Sprintf("/services/%d/gameservers", serviceID), &data); err != nil {
		return Gameserver{}, err
	}
	return data.Gameserver, nil
}
