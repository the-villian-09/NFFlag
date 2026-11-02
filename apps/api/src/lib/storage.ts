/**
 * Private file storage for uploads. Cloud Storage when UPLOADS_BUCKET is set
 * (staging, production); otherwise a folder on disk (local dev and tests).
 * Files are never public: the API reads them back after a permission check.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env } from "../config.js";

export interface FileStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

class GcsStore implements FileStore {
  private bucket: Promise<import("@google-cloud/storage").Bucket>;
  constructor(name: string) {
    this.bucket = import("@google-cloud/storage").then(({ Storage }) => new Storage().bucket(name));
  }
  async put(key: string, data: Buffer, contentType: string) {
    await (await this.bucket).file(key).save(data, { contentType, resumable: false, metadata: { cacheControl: "private, no-store" } });
  }
  async get(key: string) {
    const [buf] = await (await this.bucket).file(key).download();
    return buf;
  }
  async remove(key: string) {
    await (await this.bucket).file(key).delete({ ignoreNotFound: true });
  }
}

class DiskStore implements FileStore {
  private root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + "/")) throw new Error("bad storage key");
    return p;
  }
  async put(key: string, data: Buffer) {
    await mkdir(dirname(this.path(key)), { recursive: true });
    await writeFile(this.path(key), data);
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}

let store: FileStore | null | undefined;

/** The file store, or null when uploads aren't set up here (staging/production without a bucket). */
export function fileStore(): FileStore | null {
  if (store !== undefined) return store;
  if (env.UPLOADS_BUCKET) store = new GcsStore(env.UPLOADS_BUCKET.trim());
  else if (env.APP_ENV === "dev") store = new DiskStore(env.UPLOADS_DIR);
  else store = null; // a server's own disk is wiped on every deploy, so never store files there
  return store;
}
