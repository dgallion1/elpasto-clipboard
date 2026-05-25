// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ImageLightbox } from "./ImageLightbox";

afterEach(() => {
  cleanup();
});

describe("ImageLightbox", () => {
  test("renders image with src and alt, no counter or nav by default", () => {
    const view = render(
      <ImageLightbox src="blob:fake" alt="screenshot.png" onClose={() => undefined} />,
    );

    const img = view.getByAltText("screenshot.png") as HTMLImageElement;
    expect(img.src).toContain("blob:fake");
    expect(view.queryByRole("button", { name: "Previous image" })).toBeNull();
    expect(view.queryByRole("button", { name: "Next image" })).toBeNull();
  });

  test("renders counter when provided", () => {
    const view = render(
      <ImageLightbox
        src="blob:fake"
        alt="img"
        onClose={() => undefined}
        counter="2 / 5"
      />,
    );
    expect(view.getByText("2 / 5")).toBeTruthy();
  });

  test("backdrop click closes; image click is swallowed in single-image mode but still closes", () => {
    const onClose = vi.fn();
    const view = render(
      <ImageLightbox src="blob:fake" alt="img" onClose={onClose} />,
    );

    const backdrop = view.container.firstChild as HTMLElement;
    expect(backdrop.className).toContain("cursor-zoom-out");

    // Clicking the image in single-image mode closes (via handleImageClick)
    fireEvent.click(view.getByAltText("img"));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Clicking the backdrop (target === currentTarget) closes
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("image click does NOT close when nav handlers are present", () => {
    const onClose = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const view = render(
      <ImageLightbox
        src="blob:fake"
        alt="img"
        onClose={onClose}
        onPrev={onPrev}
        onNext={onNext}
      />,
    );

    const backdrop = view.container.firstChild as HTMLElement;
    expect(backdrop.className).toContain("cursor-default");

    fireEvent.click(view.getByAltText("img"));
    expect(onClose).not.toHaveBeenCalled();
  });

  test("prev/next buttons invoke handlers without closing", () => {
    const onClose = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const view = render(
      <ImageLightbox
        src="blob:fake"
        alt="img"
        onClose={onClose}
        onPrev={onPrev}
        onNext={onNext}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Previous image" }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Next image" }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("renders only the provided nav button", () => {
    const onPrev = vi.fn();
    const view = render(
      <ImageLightbox
        src="blob:fake"
        alt="img"
        onClose={() => undefined}
        onPrev={onPrev}
      />,
    );
    expect(view.getByRole("button", { name: "Previous image" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Next image" })).toBeNull();
  });

  test("Escape closes, ArrowLeft/Right call nav handlers", () => {
    const onClose = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <ImageLightbox
        src="blob:fake"
        alt="img"
        onClose={onClose}
        onPrev={onPrev}
        onNext={onNext}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(onPrev).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  test("arrow keys are no-ops when no nav handlers; unrelated keys do nothing", () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="blob:fake" alt="img" onClose={onClose} />);

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("removes keydown listener on unmount", () => {
    const onClose = vi.fn();
    const view = render(
      <ImageLightbox src="blob:fake" alt="img" onClose={onClose} />,
    );

    view.unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
