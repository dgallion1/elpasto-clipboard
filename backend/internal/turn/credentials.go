package turn

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"time"
)

// maxCredentialTTL caps TURN credential lifetime. Credentials only need to
// survive ICE negotiation; active allocations are maintained by the connection.
const maxCredentialTTL = 10 * time.Minute

type Credentials struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

func GenerateCredentials(secret, sessionToken string, expiresAt time.Time, turnServer string) *Credentials {
	if secret == "" {
		return nil
	}

	// Cap credential lifetime to 24h regardless of session expiry.
	credExpiry := time.Now().Add(maxCredentialTTL)
	if expiresAt.Before(credExpiry) {
		credExpiry = expiresAt
	}

	// Use HMAC of the session token as the username identifier instead of the
	// raw token, so coturn logs don't leak capability URLs.
	idMac := hmac.New(sha1.New, []byte(secret))
	idMac.Write([]byte(sessionToken))
	opaqueID := base64.RawURLEncoding.EncodeToString(idMac.Sum(nil))

	username := fmt.Sprintf("%d:%s", credExpiry.Unix(), opaqueID)

	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	return &Credentials{
		URLs: []string{
			fmt.Sprintf("turn:%s:3478?transport=udp", turnServer),
			fmt.Sprintf("turn:%s:3478?transport=tcp", turnServer),
		},
		Username:   username,
		Credential: credential,
	}
}
