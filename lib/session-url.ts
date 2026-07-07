/** Absolute URL for a session token on the current origin, stripped of query and hash. */
export function getSessionUrl(token: string): string {
  const url = new URL(window.location.href);
  url.pathname = `/${token}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/#$/, "");
}
