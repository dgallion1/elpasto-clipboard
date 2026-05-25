import { describe, expect, test } from "vitest";
import RootLayout, { metadata as rootMetadata } from "./layout";
import SessionLayout, { metadata as sessionMetadata } from "./[token]/layout";

describe("app layouts", () => {
  test("exports root metadata and wraps children in html/body", () => {
    const element = RootLayout({ children: <div>child</div> });
    const bodyChildren = Array.isArray(element.props.children.props.children)
      ? element.props.children.props.children
      : [element.props.children.props.children];

    expect(rootMetadata.title).toBe("elPasto — Shared Clipboard");
    expect(rootMetadata.description).toContain("Paste on one device");
    expect(element.type).toBe("html");
    expect(element.props.lang).toBe("en");
    expect(element.props.children.type).toBe("body");
    expect(bodyChildren.at(-1)?.props.children).toBe("child");
  });

  test("omits Cloudflare beacon when NEXT_PUBLIC_CF_ANALYTICS_TOKEN is unset", () => {
    // The token is captured at module load time, so this assertion documents
    // the default test environment (no token set).
    const element = RootLayout({ children: <div>child</div> });
    const bodyChildren = Array.isArray(element.props.children.props.children)
      ? element.props.children.props.children
      : [element.props.children.props.children];

    const hasCfScript = bodyChildren.some(
      (c: { props?: { id?: string } }) => c?.props?.id === "cf-web-analytics",
    );
    expect(hasCfScript).toBe(false);
  });

  test("exports session metadata and returns children directly", () => {
    const child = <span>session child</span>;

    expect(sessionMetadata.robots).toEqual({ index: false, follow: false });
    expect(SessionLayout({ children: child })).toBe(child);
  });
});
