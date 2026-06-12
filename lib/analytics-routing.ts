// Security (M2): session and tunnel routes carry the capability token in the URL
// path, and /stats carries the dashboard key in the query string. Third-party
// analytics beacons (Cloudflare, Plausible) report the page URL, which would leak
// those secrets to the analytics provider. Only load analytics on routes that
// contain no secrets — currently just the public landing page.

const ANALYTICS_SAFE_PATHS: ReadonlySet<string> = new Set(["/"]);

export function shouldLoadAnalytics(pathname: string): boolean {
  return ANALYTICS_SAFE_PATHS.has(pathname);
}

export { ANALYTICS_SAFE_PATHS };
