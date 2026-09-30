/**
 * Photos on the local disk. The default, and the right answer for a single-box
 * self-hosted deployment: no second service to run, no credentials to rotate,
 * and the operator's existing backup covers it.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Storage, type StoredObject } from "./index.ts";

export class FilesystemStorage implements Storage {
  readonly name = "filesystem";
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    await writeFile(`${target}.type`, contentType, "utf8");
    return { key, contentType, sizeBytes: body.length };
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    const target = this.resolve(key);
    try {
      const [body, contentType] = await Promise.all([
        readFile(target),
        readFile(`${target}.type`, "utf8").catch(() => "application/octet-stream"),
      ]);
      return { body, contentType: contentType.trim() };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.resolve(key);
    await unlink(target).catch(() => {});
    await unlink(`${target}.type`).catch(() => {});
  }

  /**
   * Resolve a key to a path, refusing anything that escapes the root. A key
   * reaches here from the database rather than from a request, but path
   * traversal is the bug that gets written once and then read as safe forever.
   */
  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new Error("refusing to resolve a storage key outside the storage root");
    }
    return target;
  }
}

/**
 * Unguessable, and sharded two levels deep so that a property with years of
 * photos does not end up with one directory holding a hundred thousand files.
 */
export function newObjectKey(prefix: string): string {
  const random = randomBytes(24).toString("hex");
  const shard = createHash("sha256").update(random).digest("hex");
  return `${prefix}/${shard.slice(0, 2)}/${shard.slice(2, 4)}/${random}`;
}
