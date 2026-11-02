import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveCheckpoint, snapshotWorkingTree } from '../src/core/checkpoints';
import { listChangedFiles } from '../src/core/diff';
import { Git } from '../src/core/git';
import { ensureStateDir } from '../src/core/layout';
import { resolveScope } from '../src/core/scopes';
import type { Turn } from '../src/core/turns';
import { createRepo } from './helpers';

describe('snapshots and scopes', () => {
  it('snapshots tracked, untracked, and staged changes without touching the index or HEAD', async () => {
    const repo = await createRepo({ 'a.txt': 'one\n', '.gitignore': 'ignored.txt\n' });
    const git = new Git(repo.root);
    await repo.write('a.txt', 'two\n');
    await repo.write('new.txt', 'fresh\n');
    await repo.write('ignored.txt', 'secret\n');
    const statusBefore = repo.git('status', '--porcelain');
    const headBefore = repo.git('rev-parse', 'HEAD');

    const tree = await snapshotWorkingTree(git);

    expect(repo.git('status', '--porcelain')).toBe(statusBefore);
    expect(repo.git('rev-parse', 'HEAD')).toBe(headBefore);
    const files = await listChangedFiles(git, 'HEAD', tree);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['a.txt', 'modified'],
      ['new.txt', 'added'],
    ]);
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('sees a same-size edit made immediately after a commit (racy-clean index entries)', async () => {
    const repo = await createRepo({ 'a.txt': 'value = 2\n' });
    await repo.write('a.txt', 'value = 3\n');
    const git = new Git(repo.root);
    const files = await listChangedFiles(git, 'HEAD', await snapshotWorkingTree(git));
    expect(files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('keeps its own state dir out of snapshots', async () => {
    const repo = await createRepo();
    const git = new Git(repo.root);
    await ensureStateDir(git);
    await repo.write('.good-vibes/comments.json', '{}');
    const files = await listChangedFiles(git, 'HEAD', await snapshotWorkingTree(git));
    expect(files).toEqual([]);
    expect(await readFile(path.join(repo.root, '.git/info/exclude'), 'utf8')).toContain('/.good-vibes/');
  });

  it('branch scope covers commits and uncommitted work since the merge base', async () => {
    const repo = await createRepo({ 'a.txt': 'base\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    await repo.write('committed.txt', 'c\n');
    repo.commit('feature work');
    await repo.write('a.txt', 'edited\n');
    const git = new Git(repo.root);

    const branch = await resolveScope(git, { kind: 'branch' }, { turns: [] });
    expect(branch.label).toBe('Branch vs main');
    expect((await listChangedFiles(git, branch.left, branch.right)).map((f) => f.path)).toEqual(['a.txt', 'committed.txt']);

    const uncommitted = await resolveScope(git, { kind: 'uncommitted' }, { turns: [] });
    expect((await listChangedFiles(git, uncommitted.left, uncommitted.right)).map((f) => f.path)).toEqual(['a.txt']);
  });

  it('turn scope diffs a turn between its checkpoints, and falls back to the working tree while open', async () => {
    const repo = await createRepo({ 'a.txt': 'one\n' });
    const git = new Git(repo.root);
    const start = await saveCheckpoint(git, 't1-start');
    await repo.write('a.txt', 'two\n');
    const end = await saveCheckpoint(git, 't1-end');
    await repo.write('later.txt', 'not part of the turn\n');

    const turn: Turn = { id: 't1', sessionId: 's', prompt: 'make it two', startedAt: '', startRef: start.ref, endRef: end.ref };
    const closed = await resolveScope(git, { kind: 'turn', turnId: 't1' }, { turns: [turn] });
    expect(closed.rightIsWorkingTree).toBe(false);
    expect((await listChangedFiles(git, closed.left, closed.right)).map((f) => f.path)).toEqual(['a.txt']);

    const open = await resolveScope(git, { kind: 'turn', turnId: 't1' }, { turns: [{ ...turn, endRef: undefined }] });
    expect(open.rightIsWorkingTree).toBe(true);
    expect((await listChangedFiles(git, open.left, open.right)).map((f) => f.path)).toEqual(['a.txt', 'later.txt']);
  });

  it('handles a repository without commits', async () => {
    const repo = await createRepo();
    repo.git('checkout', '-q', '--orphan', 'empty');
    repo.git('rm', '-rq', '--cached', '.');
    const git = new Git(repo.root);
    const scope = await resolveScope(git, { kind: 'uncommitted' }, { turns: [] });
    expect((await listChangedFiles(git, scope.left, scope.right)).map((f) => f.status)).toEqual(['added']);
  });
});
