package tunnel

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"elpasto/backend/internal/turn"
)

// FetchTurnCredentials fetches session metadata and extracts optional TURN credentials.
func FetchTurnCredentials(serverURL, token string) (*turn.Credentials, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(fmt.Sprintf("%s/api/sessions/%s", serverURL, token))
	if err != nil {
		return nil, fmt.Errorf("fetch session: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("session fetch failed: HTTP %d", resp.StatusCode)
	}

	var body struct {
		TurnCredentials *turn.Credentials `json:"turnCredentials"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode session response: %w", err)
	}

	return body.TurnCredentials, nil
}
