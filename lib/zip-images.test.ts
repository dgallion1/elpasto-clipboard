import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractImagesFromZip } from "./zip-images";

/** Helper: build a zip from a record of path → content string */
function makeZip(files: Record<string, string>): Uint8Array {
  const data: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    data[path] = strToU8(content);
  }
  return zipSync(data);
}

describe("extractImagesFromZip", () => {
  it("extracts image entries with correct mime types", async () => {
    const zip = makeZip({
      "photo.jpg": "j",
      "diagram.png": "p",
      "anim.gif": "g",
    });
    const { images, totalEntryCount } = await extractImagesFromZip(zip);

    expect(totalEntryCount).toBe(3);
    expect(images).toHaveLength(3);
    expect(images.map((i) => i.name)).toEqual([
      "anim.gif",
      "diagram.png",
      "photo.jpg",
    ]);
    expect(images[0].mimeType).toBe("image/gif");
    expect(images[1].mimeType).toBe("image/png");
    expect(images[2].mimeType).toBe("image/jpeg");
    expect(images.every((image) => image.type === "image")).toBe(true);
  });

  it("skips non-image files", async () => {
    const zip = makeZip({
      "readme.txt": "hello",
      "style.css": "body{}",
      "icon.png": "p",
      "data.json": "{}",
    });
    const { images, totalEntryCount } = await extractImagesFromZip(zip);

    expect(totalEntryCount).toBe(1);
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe("icon.png");
  });

  it("filters __MACOSX entries", async () => {
    const zip = makeZip({
      "photo.png": "p",
      "__MACOSX/._photo.png": "meta",
      "__MACOSX/subfolder/._thumb.jpg": "meta2",
    });
    const { images, totalEntryCount } = await extractImagesFromZip(zip);

    expect(totalEntryCount).toBe(1);
    expect(images[0].name).toBe("photo.png");
  });

  it("filters dotfiles", async () => {
    const zip = makeZip({
      ".hidden.png": "h",
      "sub/.thumb.jpg": "t",
      "visible.webp": "v",
    });
    const { images, totalEntryCount } = await extractImagesFromZip(zip);

    expect(totalEntryCount).toBe(1);
    expect(images[0].name).toBe("visible.webp");
  });

  it("respects limit cap", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      files[`img${String(i).padStart(2, "0")}.png`] = `data${i}`;
    }
    const zip = makeZip(files);
    const { images, totalEntryCount } = await extractImagesFromZip(zip, { limit: 5 });

    expect(totalEntryCount).toBe(25);
    expect(images).toHaveLength(5);
  });

  it("uses default limit of 20", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      files[`img${String(i).padStart(2, "0")}.png`] = `data${i}`;
    }
    const zip = makeZip(files);
    const { images, totalEntryCount } = await extractImagesFromZip(zip);

    expect(totalEntryCount).toBe(30);
    expect(images).toHaveLength(20);
  });

  it("returns empty for empty zip", async () => {
    const zip = makeZip({ "empty/": "" });
    const { images, totalEntryCount } = await extractImagesFromZip(zip);

    expect(totalEntryCount).toBe(0);
    expect(images).toHaveLength(0);
  });

  it("handles corrupt/invalid zip gracefully", async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const { images, totalEntryCount } = await extractImagesFromZip(garbage);

    expect(totalEntryCount).toBe(0);
    expect(images).toHaveLength(0);
  });

  it("matches extensions case-insensitively", async () => {
    const zip = makeZip({
      "PHOTO.JPG": "j",
      "Image.PNG": "p",
      "pic.Webp": "w",
      "art.AVIF": "a",
    });
    const { images, totalEntryCount } = await extractImagesFromZip(zip);

    expect(totalEntryCount).toBe(4);
    expect(images.map((i) => i.mimeType).sort()).toEqual([
      "image/avif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });

  it("handles all supported image extensions", async () => {
    const zip = makeZip({
      "a.jpg": "1",
      "b.jpeg": "2",
      "c.png": "3",
      "d.gif": "4",
      "e.webp": "5",
      "f.svg": "6",
      "g.bmp": "7",
      "h.avif": "8",
    });
    const { images } = await extractImagesFromZip(zip);

    expect(images).toHaveLength(8);
    const mimes = images.map((i) => i.mimeType).sort();
    expect(mimes).toEqual([
      "image/avif",
      "image/bmp",
      "image/gif",
      "image/jpeg",
      "image/jpeg",
      "image/png",
      "image/svg+xml",
      "image/webp",
    ]);
  });

  it("extracts images from nested directories", async () => {
    const zip = makeZip({
      "photos/vacation/beach.jpg": "j",
      "photos/vacation/sunset.png": "p",
      "photos/readme.txt": "text",
    });
    const { images, totalEntryCount } = await extractImagesFromZip(zip);

    expect(totalEntryCount).toBe(2);
    expect(images.map((i) => i.name).sort()).toEqual(["beach.jpg", "sunset.png"]);
    expect(images.map((i) => i.path).sort()).toEqual([
      "photos/vacation/beach.jpg",
      "photos/vacation/sunset.png",
    ]);
  });

  it("sorts results by filename for stable ordering", async () => {
    const zip = makeZip({
      "z-last.png": "1",
      "a-first.png": "2",
      "m-middle.png": "3",
    });
    const { images } = await extractImagesFromZip(zip);

    expect(images.map((i) => i.name)).toEqual([
      "a-first.png",
      "m-middle.png",
      "z-last.png",
    ]);
  });

  it("avoids inflating entries beyond the configured preview budgets", async () => {
    const zip = makeZip({
      "small.png": "1",
      "large.jpg": "12345",
      "medium.webp": "123",
    });
    const { images, totalEntryCount } = await extractImagesFromZip(zip, {
      maxImageBytes: 3,
      maxTotalPreviewBytes: 4,
    });

    expect(totalEntryCount).toBe(3);
    expect(images.map((i) => i.name)).toEqual(["medium.webp", "small.png"]);
  });

  it("preserves unique entry paths for duplicate basenames", async () => {
    const zip = makeZip({
      "cats/photo.png": "cat",
      "dogs/photo.png": "dog",
    });
    const { images, totalEntryCount } = await extractImagesFromZip(zip);

    expect(totalEntryCount).toBe(2);
    expect(images.map((i) => i.name)).toEqual(["photo.png", "photo.png"]);
    expect(images.map((i) => i.path)).toEqual(["cats/photo.png", "dogs/photo.png"]);
  });

  it("extracts PDF entries with type metadata", async () => {
    const zip = makeZip({
      "photo.png": "p",
      "doc.pdf": "pdf-data",
      "readme.txt": "hello",
    });

    const { images, totalEntryCount } = await extractImagesFromZip(zip);

    expect(totalEntryCount).toBe(2);
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.name)).toEqual(["doc.pdf", "photo.png"]);

    const pdf = images.find((image) => image.name === "doc.pdf");
    expect(pdf).toMatchObject({
      path: "doc.pdf",
      name: "doc.pdf",
      mimeType: "application/pdf",
      type: "pdf",
    });

    const image = images.find((entry) => entry.name === "photo.png");
    expect(image?.type).toBe("image");
  });

  it("sorts PDF entries alphabetically with image entries", async () => {
    const zip = makeZip({
      "c-photo.png": "p",
      "a-doc.pdf": "pdf",
      "b-image.jpg": "j",
    });

    const { images } = await extractImagesFromZip(zip);

    expect(images.map((image) => image.name)).toEqual([
      "a-doc.pdf",
      "b-image.jpg",
      "c-photo.png",
    ]);
  });
});
