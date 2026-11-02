import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { CommentsFileSchema, emptyCommentsFile, type CommentsFile } from './model';

export interface CommentStoreOptions {
  /** How long a lock may be held before it is considered abandoned by a crashed process. */
  staleLockMs?: number;
  lockTimeoutMs?: number;
}

/**
 * JSON file shared by two processes (the VS Code extension and the MCP server Claude runs).
 * Writes go through a lock file plus write-to-temp-and-rename, so readers never see a torn file
 * and concurrent read-modify-write cycles don't lose updates.
 */
export class CommentStore {
  private readonly staleLockMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    readonly filePath: string,
    private readonly lockPath: string,
    options: CommentStoreOptions = {},
  ) {
    this.staleLockMs = options.staleLockMs ?? 10_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  async read(): Promise<CommentsFile> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCommentsFile();
      throw error;
    }
    const parsed = CommentsFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`${this.filePath} is not a valid comments file: ${parsed.error.message}`);
    return parsed.data;
  }

  /** Runs `mutate` on the latest contents under the lock and persists the result. */
  async update<T>(mutate: (file: CommentsFile) => T): Promise<T> {
    const release = await this.acquireLock();
    try {
      const file = await this.read();
      const result = mutate(file);
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
      await rename(tmp, this.filePath);
      return result;
    } finally {
      await release();
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        return () => rm(this.lockPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (await this.isStale()) {
        await rm(this.lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${this.lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async isStale(): Promise<boolean> {
    const info = await stat(this.lockPath).catch(() => undefined);
    return info !== undefined && Date.now() - info.mtimeMs > this.staleLockMs;
  }
}
