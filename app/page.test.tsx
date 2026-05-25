// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const routerPushMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock("@/components/TokenInput", () => ({
  TokenInput: () => <div data-testid="token-input">token input</div>,
}));

let Home: typeof import("./page").default;

beforeAll(async () => {
  ({ default: Home } = await import("./page"));
});

beforeEach(() => {
  routerPushMock.mockReset();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Home page", () => {
  test("creates a session and redirects", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: "amber-anchor-apple-arch-arrow" }),
    });

    const view = render(<Home />);
    fireEvent.click(view.getByRole("button", { name: "New Session" }));

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/amber-anchor-apple-arch-arrow");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", { method: "POST" });
    expect(view.getByTestId("token-input").textContent).toBe("token input");
  });

  test("shows an error and recovers the button state when creation fails", async () => {
    fetchMock.mockResolvedValue({ ok: false });

    const view = render(<Home />);
    const button = view.getByRole("button", { name: "New Session" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(view.getByText("Could not create session. Try again.")).toBeTruthy();
    });
    expect(view.getByRole("button", { name: "New Session" }).hasAttribute("disabled")).toBe(false);
  });

  test("opens and closes the help modal", async () => {
    const view = render(<Home />);

    fireEvent.click(view.getByRole("button", { name: /how it works/i }));
    expect(view.getByRole("dialog", { name: "How elPasto works" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(view.queryByRole("dialog", { name: "How elPasto works" })).toBeNull();
    });
  });
});
