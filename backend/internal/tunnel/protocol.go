// Package tunnel implements the elpasto-tunnel data-channel protocol.
// Messages are JSON-encoded and sent over a WebRTC data channel labeled "tunnel".
// Every request/response pair shares a requestId for correlation.
package tunnel

import (
	"encoding/json"
	"fmt"
)

// MessageType identifies the kind of a tunnel control message.
type MessageType string

const (
	MsgAnnounce     MessageType = "tunnel:announce"
	MsgClose        MessageType = "tunnel:close"
	MsgRequest      MessageType = "tunnel:request"
	MsgRequestBody  MessageType = "tunnel:request-body"
	MsgRequestEnd   MessageType = "tunnel:request-end"
	MsgResponse     MessageType = "tunnel:response"
	MsgResponseBody MessageType = "tunnel:response-body"
	MsgResponseEnd  MessageType = "tunnel:response-end"
	MsgError        MessageType = "tunnel:error"
	MsgConfig       MessageType = "tunnel:config"
)

// AnnounceMsg is sent by the CLI when its tunnel data channel opens.
type AnnounceMsg struct {
	Type        MessageType `json:"type"`
	Label       string      `json:"label,omitempty"`       // human-readable name for the service
	Port        int         `json:"port,omitempty"`        // local port being proxied
	ServerRelay bool        `json:"serverRelay,omitempty"` // true when CLI requests server-side relay
	Prefix      string      `json:"prefix,omitempty"`      // URL prefix assigned by the server for relay
}

// ConfigMsg is sent by the server to the CLI after AnnounceMsg, providing relay configuration.
type ConfigMsg struct {
	Type   MessageType `json:"type"`
	Prefix string      `json:"prefix,omitempty"` // URL prefix the server has assigned for this tunnel
}

// CloseMsg signals that the tunnel host is shutting down.
type CloseMsg struct {
	Type MessageType `json:"type"`
}

// RequestMsg carries the HTTP request metadata from the browser relay to the CLI.
type RequestMsg struct {
	Type      MessageType       `json:"type"`
	RequestID string            `json:"requestId"`
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
}

// RequestBodyMsg carries a base64-encoded chunk of the request body.
type RequestBodyMsg struct {
	Type      MessageType `json:"type"`
	RequestID string      `json:"requestId"`
	Data      string      `json:"data"` // base64
}

// RequestEndMsg signals the end of the request body.
type RequestEndMsg struct {
	Type      MessageType `json:"type"`
	RequestID string      `json:"requestId"`
}

// ResponseMsg carries the HTTP response status and headers from the CLI back to the browser.
type ResponseMsg struct {
	Type       MessageType       `json:"type"`
	RequestID  string            `json:"requestId"`
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
}

// ResponseBodyMsg carries a base64-encoded chunk of the response body.
type ResponseBodyMsg struct {
	Type      MessageType `json:"type"`
	RequestID string      `json:"requestId"`
	Data      string      `json:"data"` // base64
}

// ResponseEndMsg signals the end of the response body.
type ResponseEndMsg struct {
	Type      MessageType `json:"type"`
	RequestID string      `json:"requestId"`
}

// ErrorMsg signals a non-recoverable error for a specific (or unknown) request.
type ErrorMsg struct {
	Type      MessageType `json:"type"`
	RequestID string      `json:"requestId,omitempty"`
	Message   string      `json:"message"`
}

// Envelope is used for type dispatch – only the Type field is decoded first.
type Envelope struct {
	Type MessageType `json:"type"`
}

// Encode marshals any message to JSON bytes.
func Encode(msg any) ([]byte, error) {
	return json.Marshal(msg)
}

// DecodeType returns the MessageType of a raw JSON payload without full decoding.
func DecodeType(raw []byte) (MessageType, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return "", fmt.Errorf("tunnel: decode type: %w", err)
	}
	return env.Type, nil
}
