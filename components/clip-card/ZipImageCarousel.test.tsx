// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ZipImageCarousel } from "./ZipImageCarousel";

afterEach(() => {
  cleanup();
});

function makeImages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    path: `dir/img${i}.png`,
    name: `img${i}.png`,
    url: `blob:fake-${i}`,
  }));
}

describe("ZipImageCarousel", () => {
  test("returns null when images array is empty", () => {
    const { container } = render(
      <ZipImageCarousel
        images={[]}
        isLimited={false}
        zipName="bundle.zip"
        zipNote="3 files"
        onDownload={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders single image without thumbnail strip", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(1)}
        isLimited={false}
        zipName="solo.zip"
        zipNote="1 file"
        onDownload={() => undefined}
      />,
    );

    const hero = view.getByAltText("img0.png") as HTMLImageElement;
    expect(hero.src).toContain("blob:fake-0");
    // Only the hero img exists — no thumbnail strip rendered for single image
    expect(view.getAllByRole("img")).toHaveLength(1);
  });

  test("renders thumbnail strip with active ring on first thumbnail", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(3)}
        isLimited={false}
        zipName="pack.zip"
        zipNote="3 files"
        onDownload={() => undefined}
      />,
    );

    const imgs = view.getAllByRole("img");
    // 1 hero + 3 thumbnails
    expect(imgs).toHaveLength(4);
    const thumbs = imgs.slice(1);
    expect(thumbs[0].className).toContain("ring-2");
    expect(thumbs[0].className).toContain("ring-blue-500");
    expect(thumbs[1].className).not.toContain("ring-2");
    expect(thumbs[2].className).not.toContain("ring-2");
  });

  test("clicking a thumbnail swaps the hero image and moves the active ring", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(3)}
        isLimited={false}
        zipName="pack.zip"
        zipNote="3 files"
        onDownload={() => undefined}
      />,
    );

    const thumbs = view.getAllByRole("img").slice(1);
    fireEvent.click(thumbs[2]);

    // Hero should now be img2
    const hero = view.getAllByRole("img")[0] as HTMLImageElement;
    expect(hero.src).toContain("blob:fake-2");
    const newThumbs = view.getAllByRole("img").slice(1);
    expect(newThumbs[2].className).toContain("ring-2");
    expect(newThumbs[0].className).not.toContain("ring-2");
  });

  test("shows 'Preview limited' notice when isLimited is true", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(1)}
        isLimited
        zipName="big.zip"
        zipNote="100 files"
        onDownload={() => undefined}
      />,
    );
    expect(view.getByText("Preview limited to first 20 items")).toBeTruthy();
  });

  test("omits 'Preview limited' notice when isLimited is false", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(1)}
        isLimited={false}
        zipName="small.zip"
        zipNote="2 files"
        onDownload={() => undefined}
      />,
    );
    expect(view.queryByText("Preview limited to first 20 items")).toBeNull();
  });

  test("falls back to 'Archive' label when zipName is null", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(1)}
        isLimited={false}
        zipName={null}
        zipNote="1 file"
        onDownload={() => undefined}
      />,
    );
    expect(view.getByText("Archive")).toBeTruthy();
  });

  test("renders zipNote and optional userNote", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(1)}
        isLimited={false}
        zipName="annotated.zip"
        zipNote="5 files · 12 MB"
        userNote="for Carol"
        onDownload={() => undefined}
      />,
    );
    expect(view.getByText("5 files · 12 MB")).toBeTruthy();
    expect(view.getByText("for Carol")).toBeTruthy();
  });

  test("omits userNote element when not provided", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(1)}
        isLimited={false}
        zipName="plain.zip"
        zipNote="1 file"
        onDownload={() => undefined}
      />,
    );
    // No italic note element should be rendered
    expect(view.container.querySelector(".italic")).toBeNull();
  });

  test("invokes onDownload when Download button is clicked", () => {
    const onDownload = vi.fn();
    const view = render(
      <ZipImageCarousel
        images={makeImages(1)}
        isLimited={false}
        zipName="d.zip"
        zipNote="1 file"
        onDownload={onDownload}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  test("clicking the hero image opens the lightbox with active src and counter for multi-image", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(3)}
        isLimited={false}
        zipName="m.zip"
        zipNote="3 files"
        onDownload={() => undefined}
      />,
    );

    fireEvent.click(view.getAllByRole("img")[0]);

    // Lightbox renders the active image again, so we now have two imgs with alt 'img0.png'
    const lightboxImg = view
      .getAllByAltText("img0.png")
      .find((el) => el.className.includes("max-h-[90vh]")) as HTMLImageElement;
    expect(lightboxImg).toBeTruthy();
    expect(lightboxImg.src).toContain("blob:fake-0");
    expect(view.getByText("1 / 3")).toBeTruthy();
    expect(view.getByRole("button", { name: "Previous image" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Next image" })).toBeTruthy();
  });

  test("single-image lightbox has no nav buttons and no counter", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(1)}
        isLimited={false}
        zipName="solo.zip"
        zipNote="1 file"
        onDownload={() => undefined}
      />,
    );

    fireEvent.click(view.getAllByRole("img")[0]);
    expect(view.queryByRole("button", { name: "Previous image" })).toBeNull();
    expect(view.queryByRole("button", { name: "Next image" })).toBeNull();
    // Counter pattern "n / m" should not appear
    expect(view.queryByText(/\d+ \/ \d+/)).toBeNull();
  });

  test("lightbox Next advances activeIndex and wraps at end", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(3)}
        isLimited={false}
        zipName="m.zip"
        zipNote="3 files"
        onDownload={() => undefined}
      />,
    );

    fireEvent.click(view.getAllByRole("img")[0]);

    fireEvent.click(view.getByRole("button", { name: "Next image" }));
    expect(view.getByText("2 / 3")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Next image" }));
    expect(view.getByText("3 / 3")).toBeTruthy();

    // Wrap from last back to first
    fireEvent.click(view.getByRole("button", { name: "Next image" }));
    expect(view.getByText("1 / 3")).toBeTruthy();
  });

  test("lightbox Previous wraps from first to last", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(3)}
        isLimited={false}
        zipName="m.zip"
        zipNote="3 files"
        onDownload={() => undefined}
      />,
    );

    fireEvent.click(view.getAllByRole("img")[0]);
    expect(view.getByText("1 / 3")).toBeTruthy();

    // Wrap from first back to last
    fireEvent.click(view.getByRole("button", { name: "Previous image" }));
    expect(view.getByText("3 / 3")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Previous image" }));
    expect(view.getByText("2 / 3")).toBeTruthy();
  });

  test("lightbox closes when Escape is pressed", () => {
    const view = render(
      <ZipImageCarousel
        images={makeImages(2)}
        isLimited={false}
        zipName="m.zip"
        zipNote="2 files"
        onDownload={() => undefined}
      />,
    );

    fireEvent.click(view.getAllByRole("img")[0]);
    expect(view.getByText("1 / 2")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByText("1 / 2")).toBeNull();
  });

  test("safeIndex clamps to 0 when images array shrinks below activeIndex", () => {
    const { rerender, container, ...view } = render(
      <ZipImageCarousel
        images={makeImages(3)}
        isLimited={false}
        zipName="m.zip"
        zipNote="3 files"
        onDownload={() => undefined}
      />,
    );

    // Move activeIndex to 2
    const thumbs = container.querySelectorAll("img");
    fireEvent.click(thumbs[3]); // index-2 thumbnail (idx 0 is hero)
    expect((container.querySelector("img") as HTMLImageElement).src).toContain(
      "blob:fake-2",
    );

    // Re-render with only 1 image — activeIndex 2 is now out of range
    rerender(
      <ZipImageCarousel
        images={makeImages(1)}
        isLimited={false}
        zipName="m.zip"
        zipNote="1 file"
        onDownload={() => undefined}
      />,
    );

    // Hero should clamp back to the only available image
    expect((container.querySelector("img") as HTMLImageElement).src).toContain(
      "blob:fake-0",
    );
    void view;
  });
});
