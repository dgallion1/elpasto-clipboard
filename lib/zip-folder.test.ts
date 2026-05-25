import { describe, it, expect, vi } from "vitest";
import { zipFolder } from "./zip-folder";
import { unzipSync } from "fflate";

// Helpers to build fake FileSystem entries

function makeFileEntry(name: string, content: string): FileSystemFileEntry {
  const blob = new File([content], name, { type: "text/plain" });
  return {
    name,
    fullPath: "/" + name,
    isFile: true,
    isDirectory: false,
    filesystem: {} as FileSystem,
    getParent: vi.fn(),
    file: (cb: (f: File) => void) => cb(blob),
  } as unknown as FileSystemFileEntry;
}

function makeDirEntry(
  name: string,
  children: FileSystemEntry[],
): FileSystemDirectoryEntry {
  return {
    name,
    fullPath: "/" + name,
    isFile: false,
    isDirectory: true,
    filesystem: {} as FileSystem,
    getParent: vi.fn(),
    createReader: () => {
      let read = false;
      return {
        readEntries: (cb: (entries: FileSystemEntry[]) => void) => {
          if (!read) {
            read = true;
            cb(children);
          } else {
            cb([]);
          }
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

describe("zipFolder", () => {
  it("zips a flat folder with two files", async () => {
    const dir = makeDirEntry("my-folder", [
      makeFileEntry("a.txt", "hello"),
      makeFileEntry("b.txt", "world"),
    ]);

    const result = await zipFolder(dir);

    expect(result.name).toBe("my-folder.zip");
    expect(result.type).toBe("application/zip");

    const buf = new Uint8Array(await result.arrayBuffer());
    const unzipped = unzipSync(buf);

    expect(Object.keys(unzipped).sort()).toEqual(["a.txt", "b.txt"]);
    expect(new TextDecoder().decode(unzipped["a.txt"])).toBe("hello");
    expect(new TextDecoder().decode(unzipped["b.txt"])).toBe("world");
  });

  it("preserves nested folder structure", async () => {
    const dir = makeDirEntry("project", [
      makeFileEntry("readme.md", "# hi"),
      makeDirEntry("src", [
        makeFileEntry("index.ts", "export {}"),
      ]),
    ]);

    const result = await zipFolder(dir);
    const buf = new Uint8Array(await result.arrayBuffer());
    const unzipped = unzipSync(buf);

    expect(Object.keys(unzipped).sort()).toEqual(["readme.md", "src/index.ts"]);
  });

  it("handles empty folder", async () => {
    const dir = makeDirEntry("empty", []);

    const result = await zipFolder(dir);
    expect(result.name).toBe("empty.zip");

    const buf = new Uint8Array(await result.arrayBuffer());
    const unzipped = unzipSync(buf);

    expect(Object.keys(unzipped)).toEqual(["empty/"]);
  });

  it("handles large batches from readEntries", async () => {
    // Simulate readEntries returning entries in two batches
    const files = Array.from({ length: 3 }, (_, i) =>
      makeFileEntry(`file${i}.txt`, `content${i}`),
    );

    const dir: FileSystemDirectoryEntry = {
      name: "batch-dir",
      fullPath: "/batch-dir",
      isFile: false,
      isDirectory: true,
      filesystem: {} as FileSystem,
      getParent: vi.fn(),
      createReader: () => {
        let callCount = 0;
        return {
          readEntries: (cb: (entries: FileSystemEntry[]) => void) => {
            if (callCount === 0) {
              callCount++;
              cb(files.slice(0, 2));
            } else if (callCount === 1) {
              callCount++;
              cb(files.slice(2));
            } else {
              cb([]);
            }
          },
        };
      },
    } as unknown as FileSystemDirectoryEntry;

    const result = await zipFolder(dir);
    const buf = new Uint8Array(await result.arrayBuffer());
    const unzipped = unzipSync(buf);

    expect(Object.keys(unzipped).sort()).toEqual([
      "file0.txt",
      "file1.txt",
      "file2.txt",
    ]);
  });
});
