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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const buildApiUrlMock = vi.fn((path: string) => path);
const fetchMock = vi.fn();
const routerPushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock("@/lib/api", () => ({
  buildApiUrl: buildApiUrlMock,
}));

let TokenInput: typeof import("./TokenInput").TokenInput;

beforeAll(async () => {
  ({ TokenInput } = await import("./TokenInput"));
});

beforeEach(() => {
  buildApiUrlMock.mockReset();
  buildApiUrlMock.mockImplementation((path: string) => path);
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  routerPushMock.mockReset();
});

afterEach(async () => {
  await act(async () => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  vi.restoreAllMocks();
});

// React's onChange for text inputs doesn't fire from fireEvent.change in
// bun's jsdom environment. This helper invokes the handler directly via
// React's internal props and flushes state updates with act().
function changeInputValue(input: HTMLInputElement, value: string) {
  const propsKey = Object.keys(input).find((k) =>
    k.startsWith("__reactProps"),
  )!;
  const props = (input as Record<string, any>)[propsKey];
  input.value = value;
  act(() => {
    props.onChange({ target: input, currentTarget: input });
  });
}

describe("TokenInput", () => {
  test("renders the join controls in their initial state", () => {
    const view = render(<TokenInput />);
    const joinButton = view.getByRole("button", { name: /join/i });

    expect(view.getByRole("combobox")).toBeTruthy();
    expect(view.getByText("0/5 words")).toBeTruthy();
    expect(joinButton.hasAttribute("disabled")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("shows suggestions for a partial word", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    act(() => {
      fireEvent.focus(input);
    });
    changeInputValue(input, "amb");

    const listbox = view.getByRole("listbox");
    expect(listbox).toBeTruthy();

    const options = view.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.textContent === "amber")).toBe(true);
  });

  test("selecting a suggestion replaces the active segment and appends a hyphen", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    act(() => {
      fireEvent.focus(input);
    });
    changeInputValue(input, "amb");

    const option = view
      .getAllByRole("option")
      .find((o) => o.textContent === "amber")!;
    act(() => {
      fireEvent.mouseDown(option);
    });

    expect(input.value).toBe("amber-");
    expect(view.queryByRole("listbox")).toBeNull();
  });

  test("navigates to the session route when a valid token is submitted", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple-arch-arrow");

    expect(view.getByText("5/5 words")).toBeTruthy();
    act(() => {
      fireEvent.click(view.getByRole("button", { name: /join/i }));
    });
    expect(routerPushMock).toHaveBeenCalledWith("/amber-anchor-apple-arch-arrow");
  });

  test("starts a lookup after the third valid word is completed", async () => {
    fetchMock.mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ token: "amber-anchor-apple-arch-arrow" }), { status: 200 }),
        ),
    );

    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple");

    await waitFor(() => {
      expect(buildApiUrlMock).toHaveBeenCalledWith("/api/sessions/lookup?prefix=amber-anchor-apple");
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  test("shows a loading state while a lookup is in flight", async () => {
    const resolveFetches: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetches.push(resolve);
        }),
    );

    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple");

    await waitFor(() => {
      expect(view.getByText("Searching for session...")).toBeTruthy();
    });

    await act(async () => {
      for (const resolveFetch of resolveFetches) {
        resolveFetch(
          new Response(JSON.stringify({ token: "amber-anchor-apple-arch-arrow" }), { status: 200 }),
        );
      }
      await Promise.resolve();
    });
  });

  test("redirects to the full token when lookup succeeds", async () => {
    fetchMock.mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ token: "amber-anchor-apple-arch-arrow" }), { status: 200 }),
        ),
    );

    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple");

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith("/amber-anchor-apple-arch-arrow");
    });
  });

  test("shows an inline message when lookup misses", async () => {
    fetchMock.mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
        ),
    );

    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple");

    await waitFor(() => {
      expect(view.getByText("No session found")).toBeTruthy();
    });
  });

  test("manual 5-word join still works after a lookup miss", async () => {
    fetchMock.mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
        ),
    );

    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple");

    await waitFor(() => {
      expect(view.getByText("No session found")).toBeTruthy();
    });

    changeInputValue(input, "amber-anchor-apple-arch-arrow");
    expect(view.queryByText("No session found")).toBeNull();

    act(() => {
      fireEvent.click(view.getByRole("button", { name: /join/i }));
    });
    expect(routerPushMock).toHaveBeenCalledWith("/amber-anchor-apple-arch-arrow");
  });

  test("stale lookup responses do not redirect after the input changes", async () => {
    const resolveFetches: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetches.push(resolve);
        }),
    );

    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple");

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    });

    changeInputValue(input, "amber-anchor-apple-arch");

    await act(async () => {
      for (const resolveFetch of resolveFetches) {
        resolveFetch(
          new Response(JSON.stringify({ token: "amber-anchor-apple-arch-arrow" }), { status: 200 }),
        );
      }
      await Promise.resolve();
    });

    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("keyboard ArrowDown/ArrowUp changes highlighted suggestion, Enter selects it", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    act(() => {
      fireEvent.focus(input);
    });
    changeInputValue(input, "br");

    const options = view.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    expect(options[1].getAttribute("aria-selected")).toBe("true");

    act(() => {
      fireEvent.keyDown(input, { key: "ArrowUp" });
    });
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(input.value).toContain("-");
    expect(view.queryByRole("listbox")).toBeNull();
  });

  test("Escape closes the suggestion list", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    act(() => {
      fireEvent.focus(input);
    });
    changeInputValue(input, "amb");
    expect(view.queryByRole("listbox")).toBeTruthy();

    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(view.queryByRole("listbox")).toBeNull();
  });

  test("blurring the input closes the suggestion list", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    act(() => {
      fireEvent.focus(input);
    });
    changeInputValue(input, "amb");
    expect(view.queryByRole("listbox")).toBeTruthy();

    act(() => {
      fireEvent.blur(input);
    });
    expect(view.queryByRole("listbox")).toBeNull();
  });

  test("Enter when list is not open and token is incomplete does nothing", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    // Type a complete word so no suggestions appear
    changeInputValue(input, "amber-anchor");

    // List should not be open
    expect(view.queryByRole("listbox")).toBeNull();

    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    // Token is not valid (only 2 words), so no navigation
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("no suggestions when activeWord is empty (trailing hyphen)", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    act(() => {
      fireEvent.focus(input);
    });
    changeInputValue(input, "amber-");

    // With trailing hyphen, activeWord is empty, so no suggestions
    expect(view.queryByRole("listbox")).toBeNull();
  });

  test("handles non-ok non-404 lookup response gracefully", async () => {
    fetchMock.mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Server error" }), { status: 500 }),
        ),
    );

    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple");

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    });

    // Should not show loading or error
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.queryByText("No session found")).toBeNull();
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("handles lookup response with missing token field", async () => {
    fetchMock.mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({}), { status: 200 }),
        ),
    );

    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple");

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await Promise.resolve();
    });

    // No redirect because body.token is undefined
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("Tab key selects highlighted suggestion when list is open", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    act(() => {
      fireEvent.focus(input);
    });
    changeInputValue(input, "br");

    const options = view.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);

    act(() => {
      fireEvent.keyDown(input, { key: "Tab" });
    });

    // Should select the suggestion and close the list
    expect(input.value).toContain("-");
    expect(view.queryByRole("listbox")).toBeNull();
  });

  test("Enter with valid complete token when list is not open navigates", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple-arch-arrow");
    expect(view.queryByRole("listbox")).toBeNull();

    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(routerPushMock).toHaveBeenCalledWith("/amber-anchor-apple-arch-arrow");
  });

  test("handles fetch network error gracefully during lookup", async () => {
    fetchMock.mockRejectedValue(new Error("Network failure"));

    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    changeInputValue(input, "amber-anchor-apple");

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Should not crash, no error displayed, no redirect
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(view.queryByText("No session found")).toBeNull();
  });

  test("no suggestions appear once all 5 words are completed", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;

    act(() => {
      fireEvent.focus(input);
    });
    changeInputValue(input, "amber-anchor-apple-arch-arrow");

    // completedWordCount >= WORD_COUNT so suggestions should be empty
    expect(view.queryByRole("listbox")).toBeNull();
  });

  test("invalid input does not navigate", () => {
    const view = render(<TokenInput />);
    const input = view.getByRole("combobox") as HTMLInputElement;
    const joinButton = view.getByRole("button", { name: /join/i });

    changeInputValue(input, "amber-anchor");

    expect(joinButton.hasAttribute("disabled")).toBe(true);
    act(() => {
      fireEvent.click(joinButton);
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });
});
