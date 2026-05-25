// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { createRef } from "react";
import { PasteZoneContent } from "./PasteZoneContent";

afterEach(cleanup);

function renderContent(overrides: Partial<ComponentProps<typeof PasteZoneContent>> = {}) {
  const fileInputRef = createRef<HTMLInputElement>();
  return render(
    <PasteZoneContent
      zone="A"
      clips={[]}
      token="session-1"
      expiresAt="2026-03-08T12:00:00Z"
      canCopyImage={true}
      getDirectClipCiphertext={() => null}
      getSendProgress={() => null}
      getTransferStats={() => null}
      readyPeerCount={0}
      unlockSecret={null}
      requestUnlockSecret={vi.fn()}
      onClipAdded={vi.fn()}
      onClipDeleted={vi.fn()}
      onQueueLocalBinaryClip={vi.fn()}
      onClearZone={vi.fn()}
      focusedZone={null}
      onFocusZone={vi.fn()}
      subscribeToSendProgress={() => () => undefined}
      subscribeToDirectTransfers={() => () => undefined}
      isFocused={true}
      isHidden={false}
      error={null}
      fileInputRef={fileInputRef}
      isClearing={false}
      isDragOver={false}
      clearZone={vi.fn()}
      handlePaste={vi.fn()}
      submitTextClip={vi.fn()}
      readClipboard={vi.fn()}
      handleDrop={vi.fn()}
      handleDragOver={vi.fn()}
      handleDragLeave={vi.fn()}
      handleFileSelect={vi.fn()}
      openFilePicker={vi.fn()}
      pendingImport={null}
      isImporting={false}
      importResult={null}
      onConfirmImport={vi.fn()}
      onCancelImport={vi.fn()}
      {...overrides}
    />
  );
}

describe("PasteZoneContent", () => {
  test("document-level paste handler skips events originating inside the zone div", () => {
    const handlePaste = vi.fn();
    const view = renderContent({ isFocused: true, handlePaste });

    // Simulate a paste event whose target is inside the zone (the zone div itself)
    const zone = view.getByLabelText(/Thread A/);
    const pasteEvent = new Event("paste", { bubbles: true }) as unknown as ClipboardEvent;
    Object.defineProperty(pasteEvent, "target", { value: zone });

    document.dispatchEvent(pasteEvent);

    // The document-level handler should have skipped this event since target is inside zoneRef
    // (the zone's onPaste handler would catch it directly instead)
    expect(handlePaste).not.toHaveBeenCalled();
  });

  test("document-level paste handler fires for events outside the zone when focused", () => {
    const handlePaste = vi.fn();
    renderContent({ isFocused: true, handlePaste });

    // Simulate paste on body (outside the zone)
    const pasteEvent = new Event("paste", { bubbles: true }) as unknown as ClipboardEvent;
    Object.defineProperty(pasteEvent, "target", { value: document.body });

    document.dispatchEvent(pasteEvent);

    expect(handlePaste).toHaveBeenCalledTimes(1);
  });

  test("document-level paste handler is not attached when not focused", () => {
    const handlePaste = vi.fn();
    renderContent({ isFocused: false, handlePaste });

    const pasteEvent = new Event("paste", { bubbles: true }) as unknown as ClipboardEvent;
    Object.defineProperty(pasteEvent, "target", { value: document.body });

    document.dispatchEvent(pasteEvent);

    expect(handlePaste).not.toHaveBeenCalled();
  });

  test("readClipboard button calls the readClipboard callback", () => {
    const readClipboard = vi.fn().mockResolvedValue(undefined);
    const view = renderContent({ readClipboard });

    fireEvent.click(view.getByText("Paste"));
    expect(readClipboard).toHaveBeenCalledTimes(1);
  });

  test("shows import result with fallback message when usedFallback is true", () => {
    const view = renderContent({
      importResult: {
        importedCount: 2,
        createdCount: 0,
        existingCount: 0,
        invalidCount: 0,
        capacityCount: 0,
        usedFallback: true,
      },
    });

    expect(view.getByText(/Imported 2 sessions locally/)).toBeTruthy();
  });

  test("shows import result with server message when usedFallback is false", () => {
    const view = renderContent({
      importResult: {
        importedCount: 3,
        createdCount: 2,
        existingCount: 1,
        invalidCount: 0,
        capacityCount: 0,
        usedFallback: false,
      },
    });

    expect(view.getByText(/Imported 3 sessions \(2 created, 1 already existed\)/)).toBeTruthy();
  });

  test("shows singular 'session' text for 1 pending import", () => {
    const view = renderContent({
      pendingImport: [{ token: "a-b-c-d-e", pinned: false }],
    });

    expect(view.getByText(/Found 1 session\./)).toBeTruthy();
  });

  test("shows plural 'sessions' text for multiple pending imports", () => {
    const view = renderContent({
      pendingImport: [
        { token: "a-b-c-d-e", pinned: false },
        { token: "f-g-h-i-j", pinned: false },
      ],
    });

    expect(view.getByText(/Found 2 sessions\./)).toBeTruthy();
  });
});
