package tunnel_test

import (
	"encoding/json"
	"testing"

	"elpasto/backend/internal/tunnel"
)

func TestEncodeDecodeType(t *testing.T) {
	tests := []struct {
		msg      any
		wantType tunnel.MessageType
	}{
		{tunnel.AnnounceMsg{Type: tunnel.MsgAnnounce, Label: "frontend", Port: 3000}, tunnel.MsgAnnounce},
		{tunnel.CloseMsg{Type: tunnel.MsgClose}, tunnel.MsgClose},
		{tunnel.RequestMsg{Type: tunnel.MsgRequest, RequestID: "r1", Method: "GET", URL: "/", Headers: map[string]string{}}, tunnel.MsgRequest},
		{tunnel.ResponseMsg{Type: tunnel.MsgResponse, RequestID: "r1", Status: 200, StatusText: "OK", Headers: map[string]string{}}, tunnel.MsgResponse},
		{tunnel.ErrorMsg{Type: tunnel.MsgError, Message: "oops"}, tunnel.MsgError},
	}

	for _, tc := range tests {
		raw, err := tunnel.Encode(tc.msg)
		if err != nil {
			t.Fatalf("Encode(%T): %v", tc.msg, err)
		}
		got, err := tunnel.DecodeType(raw)
		if err != nil {
			t.Fatalf("DecodeType: %v", err)
		}
		if got != tc.wantType {
			t.Errorf("got type %q, want %q", got, tc.wantType)
		}
	}
}

func TestAnnounceRoundTrip(t *testing.T) {
	msg := tunnel.AnnounceMsg{Type: tunnel.MsgAnnounce, Label: "backend", Port: 8080}
	raw, err := tunnel.Encode(msg)
	if err != nil {
		t.Fatal(err)
	}
	var got tunnel.AnnounceMsg
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Label != msg.Label || got.Port != msg.Port {
		t.Errorf("got %+v, want %+v", got, msg)
	}
}

func TestDecodeTypeError(t *testing.T) {
	_, err := tunnel.DecodeType([]byte("not json"))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestConfigMsgEncode(t *testing.T) {
	msg := tunnel.ConfigMsg{Type: tunnel.MsgConfig, Prefix: "/api/tunnel/abc/tok123/"}
	raw, err := tunnel.Encode(msg)
	if err != nil {
		t.Fatal(err)
	}
	var decoded tunnel.ConfigMsg
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Prefix != "/api/tunnel/abc/tok123/" {
		t.Errorf("got prefix %q", decoded.Prefix)
	}
	if decoded.Type != tunnel.MsgConfig {
		t.Errorf("got type %q", decoded.Type)
	}
}

func TestAnnounceMsgServerRelay(t *testing.T) {
	msg := tunnel.AnnounceMsg{Type: tunnel.MsgAnnounce, Label: "web", Port: 3000, ServerRelay: true}
	raw, err := tunnel.Encode(msg)
	if err != nil {
		t.Fatal(err)
	}
	var decoded tunnel.AnnounceMsg
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.ServerRelay {
		t.Error("ServerRelay should be true")
	}
}

func TestDecodeTypeConfig(t *testing.T) {
	raw, _ := tunnel.Encode(tunnel.ConfigMsg{Type: tunnel.MsgConfig, Prefix: "/x/"})
	mt, err := tunnel.DecodeType(raw)
	if err != nil {
		t.Fatal(err)
	}
	if mt != tunnel.MsgConfig {
		t.Errorf("expected %q got %q", tunnel.MsgConfig, mt)
	}
}
