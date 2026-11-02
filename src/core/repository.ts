import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { splitLines } from './comments/anchor';
import type { LineReader } from './comments/render';
import { CommentStore } from './comments/store';
import { Git, spawnGit, type GitRunner } from './git';
import { ensureStateDir, type StateLayout } from './layout';

/** Everything the extension, hook, and MCP server need for one repository. */
export interface ReviewRepository {
  git: Git;
  layout: StateLayout;
  comments: CommentStore;
  readLines: LineReader;
}

export async function openRepository(cwd: string, runner: GitRunner = spawnGit): Promise<ReviewRepository | undefined> {
  const git = await Git.discover(cwd, runner);
  if (!git) return undefined;
  const layout = await ensureStateDir(git);
  return {
    git,
    layout,
    comments: new CommentStore(layout.commentsFile, layout.commentsLock),
    readLines: (file) => readWorkingFileLines(git.root, file),
  };
}

export async function readWorkingFileLines(root: string, file: string): Promise<string[] | undefined> {
  try {
    return splitLines(await readFile(path.join(root, file), 'utf8'));
  } catch {
    return undefined;
  }
}
