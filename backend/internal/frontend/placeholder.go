package frontend

import "embed"

// placeholderHTML keeps the package buildable before packaged frontend assets exist.
//
//go:embed placeholder.html
var placeholderHTML []byte

// distFS is populated by scripts/build-frontend.sh.
//
//go:embed all:dist
var distFS embed.FS
