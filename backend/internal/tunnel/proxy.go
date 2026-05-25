package tunnel

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	// MaxConcurrentRequests caps the number of in-flight HTTP proxied requests per peer.
	MaxConcurrentRequests = 16
	// RequestTimeout is the maximum time to wait for a proxied HTTP response.
	RequestTimeout = 30 * time.Second
)

// Proxy forwards tunnel protocol messages to a local HTTP server.
type Proxy struct {
	targetURL   *url.URL // e.g. http://127.0.0.1:3000
	localPeerID string   // this CLI's peer ID — used in URL rewriting
	prefix      string   // tunnel URL prefix, e.g. /tunnel/{peerID}/
	client      *http.Client
}

// NewProxy creates a Proxy that forwards requests to targetURL.
// localPeerID is this CLI's peer ID, used for URL rewriting in HTML/redirects.
func NewProxy(targetURL string, localPeerID string) (*Proxy, error) {
	u, err := url.Parse(targetURL)
	if err != nil {
		return nil, fmt.Errorf("proxy: parse target URL: %w", err)
	}
	return &Proxy{
		targetURL:   u,
		localPeerID: localPeerID,
		prefix:      "/tunnel/" + localPeerID + "/",
		client: &http.Client{
			Timeout: RequestTimeout,
			// Don't follow redirects — we need to rewrite Location headers.
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

// SetPrefix overrides the tunnel URL prefix used for HTML rewriting and redirect
// rewriting. The prefix must begin and end with a slash (e.g. "/tunnel/peer-id/").
func (p *Proxy) SetPrefix(prefix string) {
	p.prefix = prefix
}

// Prefix returns the current tunnel URL prefix.
func (p *Proxy) Prefix() string {
	return p.prefix
}

// Handle runs the tunnel protocol loop for one browser peer connection.
// It is the single reader of recv. It fans body/end messages out to per-request
// channels, keeping the main loop unblocked.
func (p *Proxy) Handle(ctx context.Context, peerId string, send func([]byte) error, recv <-chan []byte) {
	type reqEntry struct {
		req     RequestMsg
		bodyCh  chan []byte
	}

	inFlight := make(map[string]*reqEntry)
	var mu sync.Mutex
	sem := make(chan struct{}, MaxConcurrentRequests)
	var wg sync.WaitGroup

	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case raw, ok := <-recv:
			if !ok {
				wg.Wait()
				return
			}

			msgType, err := DecodeType(raw)
			if err != nil {
				continue
			}

			switch msgType {
			case MsgRequest:
				var req RequestMsg
				if err := json.Unmarshal(raw, &req); err != nil {
					continue
				}

				select {
				case sem <- struct{}{}:
				default:
					errMsg, _ := Encode(ErrorMsg{
						Type:      MsgError,
						RequestID: req.RequestID,
						Message:   "too many concurrent requests",
					})
					_ = send(errMsg)
					continue
				}

				entry := &reqEntry{req: req, bodyCh: make(chan []byte, 32)}
				mu.Lock()
				inFlight[req.RequestID] = entry
				mu.Unlock()

				wg.Add(1)
				go func(e *reqEntry) {
					defer wg.Done()
					defer func() { <-sem }()
					defer func() {
						mu.Lock()
						delete(inFlight, e.req.RequestID)
						mu.Unlock()
					}()
					p.proxyRequest(ctx, peerId, e.req, send, e.bodyCh)
				}(entry)

			case MsgRequestBody:
				var bodyMsg RequestBodyMsg
				if err := json.Unmarshal(raw, &bodyMsg); err != nil {
					continue
				}
				mu.Lock()
				entry := inFlight[bodyMsg.RequestID]
				mu.Unlock()
				if entry != nil {
					entry.bodyCh <- raw
				}

			case MsgRequestEnd:
				var endMsg RequestEndMsg
				if err := json.Unmarshal(raw, &endMsg); err != nil {
					continue
				}
				mu.Lock()
				entry := inFlight[endMsg.RequestID]
				mu.Unlock()
				if entry != nil {
					entry.bodyCh <- raw // signal end
				}
			}
		}
	}
}

func (p *Proxy) proxyRequest(ctx context.Context, peerId string, reqMsg RequestMsg, send func([]byte) error, bodyCh <-chan []byte) {
	// Build target URL
	targetURL := *p.targetURL
	parsed, err := url.Parse(reqMsg.URL)
	if err != nil {
		sendError(send, reqMsg.RequestID, "invalid request URL")
		return
	}
	targetURL.Path = strings.TrimRight(targetURL.Path, "/") + parsed.Path
	targetURL.RawQuery = parsed.RawQuery

	reqCtx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()

	// Collect body chunks until MsgRequestEnd arrives.
	var bodyBuf strings.Builder
	done := false
	for !done {
		select {
		case raw, ok := <-bodyCh:
			if !ok {
				done = true
				break
			}
			mt, _ := DecodeType(raw)
			if mt == MsgRequestBody {
				var bm RequestBodyMsg
				if err := json.Unmarshal(raw, &bm); err == nil {
					bodyBuf.WriteString(bm.Data)
				}
			} else if mt == MsgRequestEnd {
				done = true
			}
		case <-reqCtx.Done():
			sendError(send, reqMsg.RequestID, "request timeout")
			return
		}
	}

	var bodyReader io.Reader
	if bodyBuf.Len() > 0 {
		decoded, err := base64.StdEncoding.DecodeString(bodyBuf.String())
		if err != nil {
			sendError(send, reqMsg.RequestID, "body decode error")
			return
		}
		bodyReader = bytes.NewReader(decoded)
	}

	httpReq, err := http.NewRequestWithContext(reqCtx, reqMsg.Method, targetURL.String(), bodyReader)
	if err != nil {
		sendError(send, reqMsg.RequestID, fmt.Sprintf("build request: %v", err))
		return
	}
	for k, v := range reqMsg.Headers {
		httpReq.Header.Set(k, v)
	}
	httpReq.Host = p.targetURL.Host

	resp, err := p.client.Do(httpReq)
	if err != nil {
		sendError(send, reqMsg.RequestID, fmt.Sprintf("proxy request: %v", err))
		return
	}
	defer resp.Body.Close()

	// Rewrite HTML responses: inject <base> tag, rewrite absolute-path attributes,
	// and add JS shim for fetch/XHR so all URLs resolve through the tunnel.
	// Use the CLI's own peer ID so tunnel URLs route back to this CLI, not
	// to the browser peer that sent the request.
	contentType := resp.Header.Get("Content-Type")
	tunnelPrefix := p.prefix

	// Rewrite Location header for redirects so they stay within the tunnel.
	if loc := resp.Header.Get("Location"); loc != "" {
		if strings.HasPrefix(loc, "/") && !strings.HasPrefix(loc, tunnelPrefix) {
			resp.Header.Set("Location", tunnelPrefix+loc[1:])
		}
	}

	// Send response headers.
	// Drop Content-Length for HTML responses because rewriteHTML changes the body size.
	isHTML := strings.Contains(contentType, "text/html")
	headers := make(map[string]string, len(resp.Header))
	for k := range resp.Header {
		if isHTML && strings.EqualFold(k, "Content-Length") {
			continue
		}
		headers[k] = resp.Header.Get(k)
	}
	respMsg, _ := Encode(ResponseMsg{
		Type:       MsgResponse,
		RequestID:  reqMsg.RequestID,
		Status:     resp.StatusCode,
		StatusText: resp.Status,
		Headers:    headers,
	})
	if err := send(respMsg); err != nil {
		return
	}

	// chunkSize must be a multiple of 3 so each chunk's base64 encoding has no
	// padding — the relay concatenates chunks into a single base64 string, and
	// mid-string padding breaks atob().
	const chunkSize = 32766 // 10922 * 3

	if isHTML {
		// HTML: buffer fully so we can rewrite URLs before sending.
		bodyBytes, _ := io.ReadAll(resp.Body)
		bodyBytes = rewriteHTML(bodyBytes, tunnelPrefix)
		for len(bodyBytes) > 0 {
			end := min(chunkSize, len(bodyBytes))
			chunk := base64.StdEncoding.EncodeToString(bodyBytes[:end])
			bodyBytes = bodyBytes[end:]
			bodyMsg, _ := Encode(ResponseBodyMsg{
				Type:      MsgResponseBody,
				RequestID: reqMsg.RequestID,
				Data:      chunk,
			})
			if err := send(bodyMsg); err != nil {
				return
			}
		}
	} else {
		// Non-HTML: stream in chunks to avoid buffering large downloads or SSE.
		buf := make([]byte, chunkSize)
		for {
			n, readErr := io.ReadFull(resp.Body, buf)
			if n > 0 {
				chunk := base64.StdEncoding.EncodeToString(buf[:n])
				bodyMsg, _ := Encode(ResponseBodyMsg{
					Type:      MsgResponseBody,
					RequestID: reqMsg.RequestID,
					Data:      chunk,
				})
				if err := send(bodyMsg); err != nil {
					return
				}
			}
			if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
				break
			}
			if readErr != nil {
				return
			}
		}
	}

	endMsg, _ := Encode(ResponseEndMsg{
		Type:      MsgResponseEnd,
		RequestID: reqMsg.RequestID,
	})
	_ = send(endMsg)
}

// rewriteHTML rewrites an HTML response for tunnel proxying:
// 1. Injects <base href> for relative URL resolution
// 2. Rewrites absolute-path URLs in href/src/action attributes
// 3. Injects a JS shim for fetch/XHR/EventSource/history API calls
func rewriteHTML(body []byte, prefix string) []byte {
	// Rewrite absolute-path attributes: href="/...", src="/...", action="/..."
	body = rewriteAbsolutePathAttrs(body, prefix)

	// Build injection: <base href> + JS shim for programmatic calls
	injection := []byte(`<base href="` + prefix + `">` + urlRewriteScript(prefix))

	// Only search the first 4 KiB for <head>.
	searchLen := min(4096, len(body))
	lower := bytes.ToLower(body[:searchLen])

	// Try after <head>
	if idx := bytes.Index(lower, []byte("<head>")); idx >= 0 {
		after := idx + len("<head>")
		return append(body[:after:after], append(injection, body[after:]...)...)
	}
	// Fallback: inject before </head> (reuse bounded lowercase)
	if idx := bytes.Index(lower, []byte("</head>")); idx >= 0 {
		return append(body[:idx:idx], append(injection, body[idx:]...)...)
	}
	return body
}

// attrAbsPathRe matches href="/...", src="/...", action="/..." with absolute paths.
// It captures the attribute name and quote style so we can rewrite the path.
var attrAbsPathRe = regexp.MustCompile(`(?i)((?:href|src|action)\s*=\s*)(["'])(/[^"']*)(["'])`)

// rewriteAbsolutePathAttrs rewrites absolute-path URLs in HTML attributes
// to go through the tunnel prefix. E.g. href="/explorer" → href="/tunnel/{peerId}/explorer".
func rewriteAbsolutePathAttrs(body []byte, prefix string) []byte {
	prefixBytes := []byte(prefix)
	return attrAbsPathRe.ReplaceAllFunc(body, func(match []byte) []byte {
		subs := attrAbsPathRe.FindSubmatch(match)
		if len(subs) < 5 {
			return match
		}
		attr := subs[1]  // e.g. `href="`
		quote := subs[2] // opening quote
		path := subs[3]  // e.g. `/explorer`
		end := subs[4]   // closing quote

		// Don't double-rewrite paths already under the tunnel prefix
		if bytes.HasPrefix(path, prefixBytes) {
			return match
		}
		// Rewrite: /foo → /tunnel/{peerId}/foo
		var buf bytes.Buffer
		buf.Write(attr)
		buf.Write(quote)
		buf.Write(prefixBytes)
		buf.Write(path[1:]) // skip leading /
		buf.Write(end)
		return buf.Bytes()
	})
}

// urlRewriteScript returns a <script> block that monkey-patches fetch,
// XMLHttpRequest.open, EventSource, history APIs, and link clicks so that
// absolute-path URLs from JS code go through the tunnel prefix. The click
// interceptor and MutationObserver handle SPA-rendered links that don't
// exist in the initial HTML.
func urlRewriteScript(prefix string) string {
	return `<script>(function(){` +
		`var b="` + prefix + `";` +
		`function r(u){if(typeof u==="string"&&u.startsWith("/")&&!u.startsWith(b))return b+u.slice(1);return u}` +
		// Patch fetch
		`var F=window.fetch;` +
		`window.fetch=function(i,o){` +
		`if(typeof i==="string")i=r(i);` +
		`else if(i instanceof Request){var u=r(i.url);if(u!==i.url)i=new Request(u,i)}` +
		`return F.call(this,i,o)};` +
		// Patch XMLHttpRequest.open
		`var X=XMLHttpRequest.prototype.open;` +
		`XMLHttpRequest.prototype.open=function(m,u){` +
		`arguments[1]=r(u);return X.apply(this,arguments)};` +
		// Patch EventSource
		`var E=window.EventSource;` +
		`if(E)window.EventSource=function(u,o){return new E(r(u),o)};` +
		// Patch history.pushState / replaceState
		`var hP=history.pushState,hR=history.replaceState;` +
		`history.pushState=function(s,t,u){return hP.call(this,s,t,u?r(u):u)};` +
		`history.replaceState=function(s,t,u){return hR.call(this,s,t,u?r(u):u)};` +
		// Intercept clicks on <a> tags with absolute paths (capture phase)
		`document.addEventListener("click",function(e){` +
		`var a=e.target;while(a&&a.tagName!=="A")a=a.parentElement;` +
		`if(!a||!a.href)return;` +
		`try{var u=new URL(a.href);` +
		`if(u.origin===location.origin&&u.pathname.startsWith("/")&&!u.pathname.startsWith(b)){` +
		`e.preventDefault();location.href=b+u.pathname.slice(1)+(u.search||"")+(u.hash||"")}}catch(x){}` +
		`},true);` +
		// MutationObserver: rewrite href/src/action on dynamically added elements
		`new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){` +
		`if(n.nodeType!==1)return;` +
		`var els=n.querySelectorAll?[n].concat(Array.from(n.querySelectorAll("[href],[src],[action]"))):[n];` +
		`els.forEach(function(el){` +
		`["href","src","action"].forEach(function(a){` +
		`var v=el.getAttribute&&el.getAttribute(a);` +
		`if(v&&v.startsWith("/")&&!v.startsWith(b))el.setAttribute(a,b+v.slice(1))})})})})` +
		`}).observe(document.documentElement,{childList:true,subtree:true})` +
		`})()</script>`
}


func sendError(send func([]byte) error, requestID, message string) {
	msg, _ := Encode(ErrorMsg{
		Type:      MsgError,
		RequestID: requestID,
		Message:   message,
	})
	_ = send(msg)
}
