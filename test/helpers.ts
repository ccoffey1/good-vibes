import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export interface TestRepo {
  root: string;
  git(...args: string[]): string;
  write(file: string, content: string): Promise<void>;
  commit(message: string): string;
}

/** A throwaway repository with one commit on `main`. */
export async function createRepo(files: Record<string, string> = { 'README.md': '# hello\n' }): Promise<TestRepo> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'good-vibes-test-'));
  cleanups.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  const write = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  git('init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries(files)) await write(file, content);
  commit('initial');
  return { root, git, write, commit };
}
