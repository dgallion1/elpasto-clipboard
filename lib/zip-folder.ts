import { zipSync, strToU8 } from "fflate";

/**
 * Recursively read all files from a dropped FileSystemDirectoryEntry
 * and return a single .zip File preserving the folder structure.
 */
export async function zipFolder(dir: FileSystemDirectoryEntry): Promise<File> {
  const files = await collectFiles(dir, "");
  const data: Record<string, Uint8Array> = {};
  for (const { path, bytes } of files) {
    data[path] = bytes;
  }

  // Include an empty entry if folder was empty so the zip is still valid
  if (Object.keys(data).length === 0) {
    data[dir.name + "/"] = strToU8("");
  }

  const zipped = zipSync(data);
  return new File([zipped.buffer as ArrayBuffer], dir.name + ".zip", { type: "application/zip" });
}

interface CollectedFile {
  path: string;
  bytes: Uint8Array;
}

async function collectFiles(
  dir: FileSystemDirectoryEntry,
  prefix: string,
): Promise<CollectedFile[]> {
  const entries = await readEntries(dir);
  const results: CollectedFile[] = [];

  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      const children = await collectFiles(entry as FileSystemDirectoryEntry, path);
      results.push(...children);
    } else {
      const file = await getFile(entry as FileSystemFileEntry);
      const bytes = new Uint8Array(await file.arrayBuffer());
      results.push({ path, bytes });
    }
  }

  return results;
}

function readEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const reader = dir.createReader();
    const all: FileSystemEntry[] = [];

    // readEntries returns batches of up to 100 — must call repeatedly
    const read = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
        } else {
          all.push(...batch);
          read();
        }
      }, reject);
    };
    read();
  });
}

function getFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}
