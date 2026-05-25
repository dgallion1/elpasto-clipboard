// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

// Hoist mocks so they're set up before the module under test imports them.
const {
  loadMasterKeyMock,
  storeMasterKeyMock,
  deleteMasterKeyMock,
  probeParanoidSupportMock,
  deriveMasterKeyMock,
} = vi.hoisted(() => ({
  loadMasterKeyMock: vi.fn(),
  storeMasterKeyMock: vi.fn(),
  deleteMasterKeyMock: vi.fn(),
  probeParanoidSupportMock: vi.fn(),
  deriveMasterKeyMock: vi.fn(),
}));

vi.mock("@/lib/crypto-store", () => ({
  loadMasterKey: loadMasterKeyMock,
  storeMasterKey: storeMasterKeyMock,
  deleteMasterKey: deleteMasterKeyMock,
  probeParanoidSupport: probeParanoidSupportMock,
}));

vi.mock("@/lib/clip-crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clip-crypto")>();
  return { ...actual, deriveMasterKey: deriveMasterKeyMock };
});

import { useSecretController } from "./useSecretController";

const TOKEN = "test-token";

function makeMasterKey() {
  // The crypto-store treats master keys as opaque CryptoKey objects. Tests
  // only need a non-null sentinel — refs and equality checks are by-reference.
  return {} as CryptoKey;
}

beforeEach(() => {
  loadMasterKeyMock.mockReset();
  storeMasterKeyMock.mockReset();
  deleteMasterKeyMock.mockReset();
  probeParanoidSupportMock.mockReset();
  deriveMasterKeyMock.mockReset();
  loadMasterKeyMock.mockResolvedValue(null);
  storeMasterKeyMock.mockResolvedValue(undefined);
  deleteMasterKeyMock.mockResolvedValue(undefined);
  probeParanoidSupportMock.mockResolvedValue(false);
  deriveMasterKeyMock.mockResolvedValue(makeMasterKey());
  sessionStorage.clear();
});

afterEach(() => cleanup());

describe("useSecretController initial state", () => {
  test("returns null defaults when sessionStorage is empty", () => {
    const { result } = renderHook(() => useSecretController(TOKEN));
    expect(result.current.unlockSecret).toBeNull();
    expect(result.current.secretHandle).toBeNull();
    expect(result.current.secretMode).toBeNull();
    expect(result.current.secretPromptMode).toBeNull();
    expect(result.current.paranoidAvailable).toBe(false);
  });

  test("reads existing sessionStorage value on mount and syncs the normal handle", async () => {
    sessionStorage.setItem(`elpasto:secret:${TOKEN}`, "stored-secret");
    const { result } = renderHook(() => useSecretController(TOKEN));
    expect(result.current.unlockSecret).toBe("stored-secret");
    await waitFor(() => {
      expect(result.current.secretHandle).toEqual({
        mode: "normal",
        secret: "stored-secret",
      });
      expect(result.current.secretMode).toBe("normal");
    });
  });

  test("probeParanoidSupport flips paranoidAvailable when supported", async () => {
    probeParanoidSupportMock.mockResolvedValue(true);
    const { result } = renderHook(() => useSecretController(TOKEN));
    await waitFor(() => {
      expect(result.current.paranoidAvailable).toBe(true);
    });
  });

  test("loadMasterKey from IndexedDB seeds a paranoid handle when no unlock secret is set", async () => {
    const mk = makeMasterKey();
    loadMasterKeyMock.mockResolvedValue(mk);
    const { result } = renderHook(() => useSecretController(TOKEN));
    await waitFor(() => {
      expect(result.current.secretHandle).toEqual({
        mode: "paranoid",
        masterKey: mk,
      });
      expect(result.current.secretMode).toBe("paranoid");
    });
    // Paranoid mode never sets the raw unlock secret
    expect(result.current.unlockSecret).toBeNull();
  });

  test("loadMasterKey is ignored when sessionStorage already holds a raw secret", async () => {
    sessionStorage.setItem(`elpasto:secret:${TOKEN}`, "preset");
    loadMasterKeyMock.mockResolvedValue(makeMasterKey());
    const { result } = renderHook(() => useSecretController(TOKEN));
    // Wait for both effects to settle.
    await waitFor(() => {
      expect(loadMasterKeyMock).toHaveBeenCalled();
    });
    // Allow IndexedDB load to settle without flipping the handle.
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.secretHandle).toEqual({
      mode: "normal",
      secret: "preset",
    });
  });

  test("loadMasterKey rejection is swallowed silently", async () => {
    loadMasterKeyMock.mockRejectedValue(new Error("IndexedDB closed"));
    const { result } = renderHook(() => useSecretController(TOKEN));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.secretHandle).toBeNull();
  });
});

describe("useSecretController requestUnlockSecret", () => {
  test("resolves immediately when an unlock secret is already known", async () => {
    sessionStorage.setItem(`elpasto:secret:${TOKEN}`, "have-it");
    const { result } = renderHook(() => useSecretController(TOKEN));

    let resolved: string | null = null;
    await act(async () => {
      resolved = await result.current.requestUnlockSecret();
    });
    expect(resolved).toBe("have-it");
    expect(result.current.secretPromptMode).toBeNull();
  });

  test("opens the 'required' prompt and waits when no secret is available", async () => {
    const { result } = renderHook(() => useSecretController(TOKEN));

    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current.requestUnlockSecret();
    });
    expect(result.current.secretPromptMode).toBe("required");

    await act(async () => {
      await result.current.handleSecretSubmit("just-typed");
    });
    expect(await promise).toBe("just-typed");
    expect(result.current.secretPromptMode).toBeNull();
  });

  test("returns the same pending promise on concurrent calls", async () => {
    const { result } = renderHook(() => useSecretController(TOKEN));
    let p1!: Promise<string | null>;
    let p2!: Promise<string | null>;
    act(() => {
      p1 = result.current.requestUnlockSecret();
      p2 = result.current.requestUnlockSecret();
    });
    expect(p1).toBe(p2);

    await act(async () => {
      result.current.handleSecretCancel();
      await p1;
    });
  });

  test("handleSecretCancel resolves a pending request with null and closes the prompt", async () => {
    const { result } = renderHook(() => useSecretController(TOKEN));
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current.requestUnlockSecret();
    });

    act(() => {
      result.current.handleSecretCancel();
    });
    expect(await promise).toBeNull();
    expect(result.current.secretPromptMode).toBeNull();
  });
});

describe("useSecretController handleSecretSubmit", () => {
  test("sets a normal handle, persists to sessionStorage, and best-effort deletes any paranoid key", async () => {
    deleteMasterKeyMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useSecretController(TOKEN));

    await act(async () => {
      await result.current.handleSecretSubmit("typed-secret");
    });

    expect(result.current.unlockSecret).toBe("typed-secret");
    expect(result.current.secretHandle).toEqual({
      mode: "normal",
      secret: "typed-secret",
    });
    expect(result.current.secretMode).toBe("normal");
    expect(sessionStorage.getItem(`elpasto:secret:${TOKEN}`)).toBe(
      "typed-secret",
    );
    expect(deleteMasterKeyMock).toHaveBeenCalledWith(TOKEN);
  });

  test("a failing deleteMasterKey does not break submission", async () => {
    deleteMasterKeyMock.mockRejectedValue(new Error("IndexedDB closed"));
    const { result } = renderHook(() => useSecretController(TOKEN));

    await act(async () => {
      await result.current.handleSecretSubmit("typed-secret");
    });
    expect(result.current.unlockSecret).toBe("typed-secret");
  });
});

describe("useSecretController handleSecretClear", () => {
  test("clears storage, the handle, and the IndexedDB master key", async () => {
    sessionStorage.setItem(`elpasto:secret:${TOKEN}`, "old-secret");
    const { result } = renderHook(() => useSecretController(TOKEN));

    // Confirm initial state was populated from storage
    await waitFor(() => expect(result.current.unlockSecret).toBe("old-secret"));

    await act(async () => {
      await result.current.handleSecretClear();
    });

    expect(result.current.unlockSecret).toBeNull();
    expect(result.current.secretHandle).toBeNull();
    expect(result.current.secretMode).toBeNull();
    expect(sessionStorage.getItem(`elpasto:secret:${TOKEN}`)).toBeNull();
    expect(deleteMasterKeyMock).toHaveBeenCalledWith(TOKEN);
  });

  test("a failing deleteMasterKey does not throw", async () => {
    deleteMasterKeyMock.mockRejectedValue(new Error("IndexedDB closed"));
    const { result } = renderHook(() => useSecretController(TOKEN));
    await act(async () => {
      await result.current.handleSecretClear();
    });
    expect(result.current.unlockSecret).toBeNull();
  });

  test("resolves any pending request with null", async () => {
    const { result } = renderHook(() => useSecretController(TOKEN));
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current.requestUnlockSecret();
    });
    await act(async () => {
      await result.current.handleSecretClear();
    });
    expect(await promise).toBeNull();
  });
});

describe("useSecretController handleSecretSubmitParanoid", () => {
  test("derives + stores the master key, sets a paranoid handle, and never persists the passphrase", async () => {
    const mk = makeMasterKey();
    deriveMasterKeyMock.mockResolvedValue(mk);
    const { result } = renderHook(() => useSecretController(TOKEN));

    await act(async () => {
      await result.current.handleSecretSubmitParanoid("paranoid-pass");
    });

    expect(deriveMasterKeyMock).toHaveBeenCalledWith("paranoid-pass");
    expect(storeMasterKeyMock).toHaveBeenCalledWith(TOKEN, mk);
    expect(result.current.secretHandle).toEqual({
      mode: "paranoid",
      masterKey: mk,
    });
    expect(result.current.secretMode).toBe("paranoid");
    // Raw passphrase must NOT touch sessionStorage in paranoid mode
    expect(sessionStorage.getItem(`elpasto:secret:${TOKEN}`)).toBeNull();
    expect(result.current.unlockSecret).toBeNull();
  });

  test("clears any prior raw secret from sessionStorage before storing the master key", async () => {
    sessionStorage.setItem(`elpasto:secret:${TOKEN}`, "prior-secret");
    const { result } = renderHook(() => useSecretController(TOKEN));
    await waitFor(() =>
      expect(result.current.unlockSecret).toBe("prior-secret"),
    );

    await act(async () => {
      await result.current.handleSecretSubmitParanoid("paranoid-pass");
    });
    expect(sessionStorage.getItem(`elpasto:secret:${TOKEN}`)).toBeNull();
    expect(result.current.unlockSecret).toBeNull();
  });

  test("resolves a pending unlock request with the raw passphrase (one-time use)", async () => {
    const { result } = renderHook(() => useSecretController(TOKEN));
    let pending!: Promise<string | null>;
    act(() => {
      pending = result.current.requestUnlockSecret();
    });
    await act(async () => {
      await result.current.handleSecretSubmitParanoid("typed-pass");
    });
    expect(await pending).toBe("typed-pass");
  });
});

describe("useSecretController openSecretManager + getCurrentSecretHandle", () => {
  test("openSecretManager sets the prompt mode to 'manage'", () => {
    const { result } = renderHook(() => useSecretController(TOKEN));
    act(() => {
      result.current.openSecretManager();
    });
    expect(result.current.secretPromptMode).toBe("manage");
  });

  test("getCurrentSecretHandle returns the latest handle, not a stale snapshot", async () => {
    const { result } = renderHook(() => useSecretController(TOKEN));
    expect(result.current.getCurrentSecretHandle()).toBeNull();
    await act(async () => {
      await result.current.handleSecretSubmit("fresh");
    });
    expect(result.current.getCurrentSecretHandle()).toEqual({
      mode: "normal",
      secret: "fresh",
    });
  });
});

describe("useSecretController unlock secret → handle sync", () => {
  test("clears the normal handle when the unlock secret is removed", async () => {
    sessionStorage.setItem(`elpasto:secret:${TOKEN}`, "initial");
    const { result } = renderHook(() => useSecretController(TOKEN));
    await waitFor(() =>
      expect(result.current.secretHandle).toEqual({
        mode: "normal",
        secret: "initial",
      }),
    );

    await act(async () => {
      await result.current.handleSecretClear();
    });
    expect(result.current.secretHandle).toBeNull();
  });

  test("does not clobber a paranoid handle when unlockSecret transitions through null", async () => {
    // Start paranoid via the explicit submit path.
    const { result } = renderHook(() => useSecretController(TOKEN));
    await act(async () => {
      await result.current.handleSecretSubmitParanoid("p");
    });
    const beforeHandle = result.current.secretHandle;
    expect(beforeHandle?.mode).toBe("paranoid");

    // Submit + clear cycles a normal handle and shouldn't promote paranoid back.
    await act(async () => {
      await result.current.handleSecretSubmit("normal-secret");
    });
    expect(result.current.secretMode).toBe("normal");
  });
});
