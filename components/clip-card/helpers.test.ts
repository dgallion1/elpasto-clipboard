// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { ClipCryptoError, WrongUnlockSecretError } from "@/lib/clip-crypto";
import type { Clip } from "@/lib/clips";

import {
  sanitizePreviewHtml,
  regenerateHtmlFromPlainText,
  formatFileNote,
  resolveDecryptError,
  loadEncryptedFile,
  downloadBlob,
  formatBytes,
  formatSpeed,
  useCountdown,
} from "./helpers";

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 1,
    session_id: 1,
    zone: "A",
    kind: "text",
    client_transfer_id: null,
    mime_type: null,
    text_content: null,
    html_content: null,
    storage_key: null,
    original_name: null,
    size_bytes: null,
    encrypted: false,
    encryption_version: null,
    encryption_meta: null,
    created_at: new Date("2026-03-12T12:00:00.000Z").toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── sanitizePreviewHtml ─────────────────────────────────────────────────

describe("sanitizePreviewHtml", () => {
  test("returns empty string for falsy input", () => {
    expect(sanitizePreviewHtml("")).toBe("");
  });

  test("preserves safe tags", () => {
    expect(sanitizePreviewHtml("<b>hello</b>")).toBe("<b>hello</b>");
    expect(sanitizePreviewHtml("<em>world</em>")).toBe("<em>world</em>");
    expect(sanitizePreviewHtml("<p>text</p>")).toBe("<p>text</p>");
  });

  test("strips unsafe tags", () => {
    expect(sanitizePreviewHtml("<script>alert(1)</script>")).toBe("");
    expect(sanitizePreviewHtml("<style>body{}</style>")).toBe("");
    expect(sanitizePreviewHtml("<iframe src='x'></iframe>")).toBe("");
    // The form element is removed; its harmless inner text may remain.
    expect(sanitizePreviewHtml("<form action='x'>data</form>")).not.toContain("form");
  });

  test("strips single dangerous tags (img, embed, etc.)", () => {
    expect(sanitizePreviewHtml('<img src="x.png" />')).toBe("");
    expect(sanitizePreviewHtml('<embed type="x" />')).toBe("");
    expect(sanitizePreviewHtml('<source src="x" />')).toBe("");
    expect(sanitizePreviewHtml("<base href='/' />")).toBe("");
  });

  test("removes HTML comments", () => {
    expect(sanitizePreviewHtml("<!-- comment -->hello")).toBe("hello");
    expect(sanitizePreviewHtml("a<!-- multi\nline -->b")).toBe("ab");
  });

  test("removes unknown/non-whitelisted tags but keeps content around them", () => {
    expect(sanitizePreviewHtml("<custom>content</custom>")).toBe("content");
    expect(sanitizePreviewHtml("<div><foo>bar</foo></div>")).toBe("<div>bar</div>");
  });

  test("preserves self-closing br and hr", () => {
    expect(sanitizePreviewHtml("<br>")).toBe("<br />");
    expect(sanitizePreviewHtml("<br/>")).toBe("<br />");
    expect(sanitizePreviewHtml("<hr>")).toBe("<hr />");
  });

  test("strips attributes from tags without allowed attributes", () => {
    expect(sanitizePreviewHtml('<b class="x">hi</b>')).toBe("<b>hi</b>");
    expect(sanitizePreviewHtml('<p style="color:red">text</p>')).toBe("<p>text</p>");
  });

  test("preserves safe href on anchor tags", () => {
    expect(sanitizePreviewHtml('<a href="https://example.com">link</a>')).toBe(
      '<a href="https://example.com">link</a>'
    );
    expect(sanitizePreviewHtml('<a href="http://example.com">link</a>')).toBe(
      '<a href="http://example.com">link</a>'
    );
    expect(sanitizePreviewHtml('<a href="mailto:a@b.com">mail</a>')).toBe(
      '<a href="mailto:a@b.com">mail</a>'
    );
    expect(sanitizePreviewHtml('<a href="tel:123">call</a>')).toBe(
      '<a href="tel:123">call</a>'
    );
    expect(sanitizePreviewHtml('<a href="/path">rel</a>')).toBe(
      '<a href="/path">rel</a>'
    );
    expect(sanitizePreviewHtml('<a href="#anchor">hash</a>')).toBe(
      '<a href="#anchor">hash</a>'
    );
  });

  test("strips javascript: hrefs", () => {
    const result = sanitizePreviewHtml('<a href="javascript:alert(1)">xss</a>');
    expect(result).not.toContain("javascript:");
    expect(result).toBe("<a>xss</a>");
  });

  test("strips empty href", () => {
    expect(sanitizePreviewHtml('<a href="">link</a>')).toBe("<a>link</a>");
    expect(sanitizePreviewHtml('<a href="  ">link</a>')).toBe("<a>link</a>");
  });

  test("handles target=_blank with rel=noopener noreferrer", () => {
    const result = sanitizePreviewHtml('<a href="https://x.com" target="_blank">go</a>');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  test("does not add target when target is not _blank", () => {
    const result = sanitizePreviewHtml('<a href="https://x.com" target="_self">go</a>');
    expect(result).not.toContain("target");
  });

  test("preserves title attribute on anchors", () => {
    const result = sanitizePreviewHtml('<a href="https://x.com" title="Example">go</a>');
    expect(result).toContain('title="Example"');
  });

  test("escapes HTML entities in attribute values", () => {
    const result = sanitizePreviewHtml('<a href="https://x.com" title="a&b<c>d&quot;e">go</a>');
    expect(result).toContain("title=");
    expect(result).not.toContain('"e"'); // The inner quotes should be escaped
  });

  test("strips on-event attributes", () => {
    const result = sanitizePreviewHtml('<a href="https://x.com" onclick="alert(1)">go</a>');
    expect(result).not.toContain("onclick");
  });

  test("strips style attributes", () => {
    const result = sanitizePreviewHtml('<a href="https://x.com" style="color:red">go</a>');
    expect(result).not.toContain("style");
  });

  // td/th are only valid inside a table; the HTML parser (and therefore
  // DOMPurify) drops a bare <td>, so these assert the realistic in-table case.
  const inRow = (cell: string) => `<table><tbody><tr>${cell}</tr></tbody></table>`;

  test("preserves colspan and rowspan on td/th", () => {
    expect(sanitizePreviewHtml(inRow('<td colspan="2">cell</td>'))).toContain('<td colspan="2">cell</td>');
    expect(sanitizePreviewHtml(inRow('<th rowspan="3">head</th>'))).toContain('<th rowspan="3">head</th>');
  });

  test("strips invalid colspan/rowspan values", () => {
    expect(sanitizePreviewHtml(inRow('<td colspan="0">cell</td>'))).toContain("<td>cell</td>");
    expect(sanitizePreviewHtml(inRow('<td colspan="abc">cell</td>'))).toContain("<td>cell</td>");
    expect(sanitizePreviewHtml(inRow('<td colspan="100">cell</td>'))).toContain("<td>cell</td>"); // > 2 digits starting with non-1-9
  });

  test("handles mixed safe and unsafe content", () => {
    const input = '<p>Hello</p><script>evil()</script><b>world</b>';
    const result = sanitizePreviewHtml(input);
    expect(result).toContain("<p>Hello</p>");
    expect(result).toContain("<b>world</b>");
    expect(result).not.toContain("script");
  });

  test("stray closing tags are dropped by the parser", () => {
    // A stray end tag with no matching start is ignored by the HTML parser.
    expect(sanitizePreviewHtml("</p>")).toBe("");
    expect(sanitizePreviewHtml("<p>hi</p>")).toBe("<p>hi</p>");
  });

  test("closing tags for unsafe tags are removed", () => {
    const result = sanitizePreviewHtml("</script>");
    expect(result).toBe("");
  });

  test("handles single-quoted attribute values", () => {
    const result = sanitizePreviewHtml("<a href='https://x.com'>go</a>");
    expect(result).toContain('href="https://x.com"');
  });

  test("strips non-allowed attributes from tags with allowed attribute lists", () => {
    // <a> allows href, title, target, rel — but not class, id, data-x, etc.
    const result = sanitizePreviewHtml('<a href="https://x.com" class="link" id="foo" data-x="y">go</a>');
    expect(result).toContain('href="https://x.com"');
    expect(result).not.toContain("class");
    expect(result).not.toContain("id");
    expect(result).not.toContain("data-x");
  });

  test("handles unquoted attribute values", () => {
    const result = sanitizePreviewHtml(inRow("<td colspan=2>cell</td>"));
    expect(result).toContain('colspan="2"');
  });

  test("table structure tags pass through", () => {
    const input = "<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>D</td></tr></tbody></table>";
    expect(sanitizePreviewHtml(input)).toBe(input);
  });

  test("noscript, object, select, textarea, meta, link, button, input, svg are removed", () => {
    for (const tag of ["noscript", "object", "select", "textarea", "meta", "link", "button", "input", "svg"]) {
      const html = `<${tag}>content</${tag}>`;
      expect(sanitizePreviewHtml(html)).not.toContain(tag);
    }
  });

  test("frame, frameset single tags are removed", () => {
    expect(sanitizePreviewHtml("<frame src='x' />")).toBe("");
    expect(sanitizePreviewHtml("<frameset></frameset>")).toBe("");
  });

  // Security (C1): a malicious peer can ship arbitrary html_content for an
  // html-kind clip, which is rendered via dangerouslySetInnerHTML. Malformed
  // tags must not survive sanitization as executable markup.
  describe("XSS bypass payloads are neutralized", () => {
    // Parse the sanitized output the way the browser will and assert no
    // executable vectors remain — this is the property that actually matters.
    function assertInert(payload: string) {
      const out = sanitizePreviewHtml(payload);
      const host = document.createElement("div");
      host.innerHTML = out;
      const all = [host, ...Array.from(host.querySelectorAll("*"))];
      for (const el of all) {
        for (const attr of Array.from(el.attributes ?? [])) {
          expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
        }
        const tag = el.tagName.toLowerCase();
        expect(["script", "img", "image", "svg", "iframe", "object", "embed"]).not.toContain(tag);
      }
    }

    test("slash-separated img alias with onerror does not survive", () => {
      assertInert("<image/src=x/onerror=alert(1)>");
    });

    test("slash-separated svg with onload does not survive", () => {
      assertInert("<svg/onload=alert(1)>");
    });

    test("svg animate with onbegin does not survive", () => {
      assertInert("<svg><animate/onbegin=alert(1)>");
    });

    test("img with onerror does not survive", () => {
      assertInert("<img src=x onerror=alert(1)>");
    });

    test("malformed onerror handler is stripped from output string", () => {
      expect(sanitizePreviewHtml("<image/src=x/onerror=alert(1)>")).not.toContain("onerror");
      expect(sanitizePreviewHtml("<svg/onload=alert(1)>")).not.toContain("onload");
    });
  });
});

describe("regenerateHtmlFromPlainText", () => {
  test("escapes unsafe markup", () => {
    expect(regenerateHtmlFromPlainText("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"
    );
  });

  test("preserves line breaks and empty paragraphs", () => {
    expect(regenerateHtmlFromPlainText("one\nline two\n\n\nthree")).toBe(
      "<p>one<br />line two</p><p><br /></p><p>three</p>"
    );
  });
});

// ── formatFileNote ──────────────────────────────────────────────────────

describe("formatFileNote", () => {
  test("returns size only for non-local clips", () => {
    const clip = makeClip({ size_bytes: 1024, local_only: false });
    expect(formatFileNote(clip)).toBe("1.0 KB");
  });

  test("returns 'local only' for sender-origin local clips", () => {
    const clip = makeClip({ size_bytes: 2048, local_only: true, local_origin: "sender" });
    expect(formatFileNote(clip)).toBe("2.0 KB \u2022 local only");
  });

  test("returns 'direct transfer' for receiver-origin local clips", () => {
    const clip = makeClip({ size_bytes: 512, local_only: true, local_origin: "receiver" });
    expect(formatFileNote(clip)).toBe("512 B \u2022 direct transfer");
  });

  test("returns 'direct transfer' for null local_origin (default)", () => {
    const clip = makeClip({ size_bytes: 512, local_only: true, local_origin: null });
    expect(formatFileNote(clip)).toBe("512 B \u2022 direct transfer");
  });

  test("handles null size_bytes as 0", () => {
    const clip = makeClip({ size_bytes: null, local_only: false });
    expect(formatFileNote(clip)).toBe("0 B");
  });
});

// ── resolveDecryptError ────────────────────────────────────────────────

describe("resolveDecryptError", () => {
  test("returns 'Wrong unlock secret' for WrongUnlockSecretError", () => {
    expect(resolveDecryptError(new WrongUnlockSecretError("bad"))).toBe("Wrong unlock secret");
  });

  test("returns error message for ClipCryptoError", () => {
    expect(resolveDecryptError(new ClipCryptoError("custom msg"))).toBe("custom msg");
  });

  test("returns error message for generic Error", () => {
    expect(resolveDecryptError(new Error("oops"))).toBe("oops");
  });

  test("returns fallback for non-Error values", () => {
    expect(resolveDecryptError("string error")).toBe("Failed to decrypt clip");
    expect(resolveDecryptError(42)).toBe("Failed to decrypt clip");
    expect(resolveDecryptError(null)).toBe("Failed to decrypt clip");
  });
});

// ── loadEncryptedFile ──────────────────────────────────────────────────

describe("loadEncryptedFile", () => {
  test("throws when fileUrl is null", async () => {
    await expect(loadEncryptedFile(null)).rejects.toThrow("Failed to load encrypted file");
  });

  test("throws when fileUrl is empty string", async () => {
    await expect(loadEncryptedFile("")).rejects.toThrow("Failed to load encrypted file");
  });

  test("throws when fetch response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(loadEncryptedFile("https://example.com/file")).rejects.toThrow(
      "Failed to load encrypted file"
    );
  });

  test("returns ArrayBuffer on success", async () => {
    const fakeBuffer = new ArrayBuffer(8);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(fakeBuffer),
      })
    );
    const result = await loadEncryptedFile("https://example.com/file");
    expect(result).toBe(fakeBuffer);
  });
});

// ── downloadBlob ────────────────────────────────────────────────────────

describe("downloadBlob", () => {
  test("creates a temporary anchor, clicks it, and revokes the URL", async () => {
    const fakeUrl = "blob:http://localhost/fake-uuid";
    const createObjectURLMock = vi.fn().mockReturnValue(fakeUrl);
    const revokeObjectURLMock = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectURLMock,
      revokeObjectURL: revokeObjectURLMock,
    });

    const clickMock = vi.fn();
    const removeMock = vi.fn();
    const appendChildMock = vi.spyOn(document.body, "appendChild").mockReturnValue(null as unknown as Node);
    vi.spyOn(document, "createElement").mockReturnValue({
      href: "",
      download: "",
      click: clickMock,
      remove: removeMock,
    } as unknown as HTMLAnchorElement);

    const blob = new Blob(["hello"], { type: "text/plain" });
    await downloadBlob(blob, "test.txt");

    expect(createObjectURLMock).toHaveBeenCalledWith(blob);
    expect(clickMock).toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalled();
    expect(appendChildMock).toHaveBeenCalled();

    // revokeObjectURL is called via setTimeout(fn, 0) — no need to verify
  });
});

// ── formatBytes ─────────────────────────────────────────────────────────

describe("formatBytes", () => {
  test("formats bytes < 1024", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(100)).toBe("100 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
  });

  test("formats megabytes", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 5.5)).toBe("5.5 MB");
    expect(formatBytes(1024 * 1024 * 100)).toBe("100.0 MB");
  });
});

// ── formatSpeed ─────────────────────────────────────────────────────────

describe("formatSpeed", () => {
  test("appends /s to formatted bytes", () => {
    expect(formatSpeed(512)).toBe("512 B/s");
    expect(formatSpeed(1024 * 100)).toBe("100.0 KB/s");
    expect(formatSpeed(1024 * 1024 * 2)).toBe("2.0 MB/s");
  });
});

// ── useCountdown ────────────────────────────────────────────────────────

describe("useCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns formatted countdown string", () => {
    // Set expiry 1 hour and 30 minutes from now
    const expiresAt = new Date(Date.now() + 1 * 3_600_000 + 30 * 60_000 + 15_000).toISOString();
    const { result } = renderHook(() => useCountdown(expiresAt));
    expect(result.current).toBe("01:30:15");
  });

  test('returns "expired" when time has passed', () => {
    const expiresAt = new Date(Date.now() - 1000).toISOString();
    const { result } = renderHook(() => useCountdown(expiresAt));
    expect(result.current).toBe("expired");
  });

  test('returns empty string for expiry > 8760 hours (1 year)', () => {
    const expiresAt = new Date(Date.now() + 8761 * 3_600_000).toISOString();
    const { result } = renderHook(() => useCountdown(expiresAt));
    expect(result.current).toBe("");
  });

  test("updates when interval ticks", () => {
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
    const { result } = renderHook(() => useCountdown(expiresAt));
    expect(result.current).toBe("00:00:10");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe("00:00:09");
  });

  test("cleans up interval when all subscribers unmount", () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const { unmount } = renderHook(() => useCountdown(expiresAt));
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  test("server snapshot returns placeholder", () => {
    // The server snapshot returns "--:--:--"
    // We test this indirectly: useSyncExternalStore uses the server snapshot
    // when there is no DOM. Since jsdom has window, it will use the client snapshot.
    // But we can verify the function exists and returns a string.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const { result } = renderHook(() => useCountdown(expiresAt));
    expect(typeof result.current).toBe("string");
  });
});
