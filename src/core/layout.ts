import { realpathSync } from 'node:fs';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Git } from './git';

/** Per-repository state lives here; it is excluded from git via `info/exclude`, never `.gitignore`. */
export const STATE_DIR_NAME = '.good-vibes';

export interface StateLayout {
  root: string;
  dir: string;
  commentsFile: string;
  commentsLock: string;
  turnsFile: string;
  outboxDir: string;
  hookLog: string;
}

export function stateLayout(root: string): StateLayout {
  const dir = path.join(root, STATE_DIR_NAME);
  return {
    root,
    dir,
    commentsFile: path.join(dir, 'comments.json'),
    commentsLock: path.join(dir, 'comments.lock'),
    turnsFile: path.join(dir, 'turns.jsonl'),
    outboxDir: path.join(dir, 'outbox'),
    hookLog: path.join(dir, 'hook.log'),
  };
}

/** Creates the state dir and keeps it out of `git status` and checkpoint snapshots. */
export async function ensureStateDir(git: Git): Promise<StateLayout> {
  const layout = stateLayout(git.root);
  await mkdir(layout.outboxDir, { recursive: true });
  await ensureExcluded(git, `/${STATE_DIR_NAME}/`);
  return layout;
}

async function ensureExcluded(git: Git, pattern: string): Promise<void> {
  const excludeFile = await git.gitPath('info/exclude');
  const current = await readFile(excludeFile, 'utf8').catch(() => '');
  if (current.split(/\r?\n/).includes(pattern)) return;
  await mkdir(path.dirname(excludeFile), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  await appendFile(excludeFile, `${prefix}${pattern}\n`);
}

/**
 * Repo-relative POSIX path for an absolute or relative path, or undefined if it escapes the repo.
 * Symlinked spellings of the root (e.g. macOS `/var` vs `/private/var`) are resolved first.
 */
export function toRepoPath(root: string, file: string): string | undefined {
  const absolute = path.isAbsolute(file) ? file : path.join(root, file);
  for (const candidate of [absolute, resolveExisting(absolute)]) {
    const relative = path.relative(root, candidate);
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  }
  return undefined;
}

/** realpath of the deepest existing ancestor, with the missing tail re-appended. */
function resolveExisting(file: string): string {
  const tail: string[] = [];
  let current = file;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return file;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}
