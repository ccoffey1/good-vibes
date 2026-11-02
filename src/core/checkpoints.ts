import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Git } from './git';

export const CHECKPOINT_REF_PREFIX = 'refs/good-vibes/checkpoints/';

/** Fixed identity so snapshot commits don't depend on (or leak) the user's git config. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Good Vibes',
  GIT_AUTHOR_EMAIL: 'checkpoint@good-vibes.invalid',
  GIT_COMMITTER_NAME: 'Good Vibes',
  GIT_COMMITTER_EMAIL: 'checkpoint@good-vibes.invalid',
};

/**
 * Writes the full working tree (tracked + untracked, honoring ignore rules) as a tree object
 * without touching HEAD, the real index, or any file on disk.
 *
 * The temporary index is seeded with a copy of the real index rather than `read-tree HEAD`:
 * the copy carries stat info, so `add -A` only re-hashes files that actually changed.
 */
export async function snapshotWorkingTree(git: Git): Promise<string> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'good-vibes-index-'));
  const tmpIndex = path.join(tmpDir, 'index');
  try {
    await copyIndex(await git.gitPath('index'), tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git.exec(['add', '-A', '--', '.'], { env });
    return (await git.exec(['write-tree'], { env })).trim();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Copies the index keeping its mtime. Git treats entries modified in the same instant as the index
 * file as "racily clean" and re-reads them; a fresh mtime on the copy would disable that check and
 * same-size edits made right after `git add`/`commit` would be missed.
 */
async function copyIndex(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
    const { atime, mtime } = await stat(from);
    await utimes(to, atime, mtime);
  } catch (error) {
    // No index yet (fresh repo): start empty.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export interface Checkpoint {
  ref: string;
  commit: string;
  tree: string;
}

/** Snapshots the working tree into a private ref. Never moves HEAD or touches files. */
export async function saveCheckpoint(git: Git, name: string): Promise<Checkpoint> {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid checkpoint name: ${name}`);
  const tree = await snapshotWorkingTree(git);
  const head = (await git.revParse('HEAD')) ?? 'none';
  const message = `good-vibes checkpoint ${name}\n\nhead ${head}\n`;
  const commit = (await git.exec(['commit-tree', tree], { input: message, env: SNAPSHOT_IDENTITY })).trim();
  const ref = `${CHECKPOINT_REF_PREFIX}${name}`;
  await git.exec(['update-ref', ref, commit]);
  return { ref, commit, tree };
}

/** Deletes checkpoint refs; the objects are reclaimed by git's normal gc. */
export async function deleteCheckpoints(git: Git, refs: readonly string[]): Promise<void> {
  if (refs.length === 0) return;
  const input = refs.map((ref) => `delete ${ref}\n`).join('');
  await git.exec(['update-ref', '--stdin'], { input });
}
