import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastAiTitle, projectSlug, readSessionInfo } from '../src/core/claudeSessions';

describe('Claude session titles', () => {
  it('slugs project directories the way Claude does', () => {
    expect(projectSlug('/Users/me/Coding/good-vibes')).toBe('-Users-me-Coding-good-vibes');
    expect(projectSlug('/private/tmp/claude-501/-x_y.z')).toBe('-private-tmp-claude-501--x-y-z');
  });

  it('takes the most recent ai-title and tolerates truncated lines', () => {
    const text = ['{"type":"ai-title","aiTitle":"Old"', '{"type":"user"}', '{"type":"ai-title","aiTitle":"New title"}', '{"type":"ai-ti'].join('\n');
    expect(lastAiTitle(text)).toBe('New title');
    expect(lastAiTitle('{"type":"user"}')).toBeUndefined();
  });

  it('resolves pid → session → transcript title, and degrades to no title', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'gv-claude-home-'));
    const cwd = '/work/my.repo';
    await mkdir(path.join(home, 'sessions'));
    await mkdir(path.join(home, 'projects', projectSlug(cwd)), { recursive: true });
    await writeFile(path.join(home, 'sessions', '42.json'), JSON.stringify({ pid: 42, sessionId: 'abc', cwd, status: 'busy', extra: true }));
    await writeFile(path.join(home, 'projects', projectSlug(cwd), 'abc.jsonl'), '{"type":"ai-title","aiTitle":"Fix login","sessionId":"abc"}\n');

    expect(await readSessionInfo(42, home)).toEqual({ pid: 42, sessionId: 'abc', status: 'busy', title: 'Fix login' });
    expect(await readSessionInfo(7, home)).toEqual({ pid: 7 });
    await writeFile(path.join(home, 'sessions', '8.json'), JSON.stringify({ pid: 8, sessionId: 'new', cwd, status: 'idle' }));
    expect(await readSessionInfo(8, home)).toEqual({ pid: 8, sessionId: 'new', status: 'idle', title: undefined });
  });
});

describe('listRunningSessions', () => {
  it('keeps live sessions inside the repo and skips dead or unrelated ones', async () => {
    const { listRunningSessions } = await import('../src/core/claudeSessions');
    const home = await mkdtemp(path.join(os.tmpdir(), 'gv-claude-home-'));
    await mkdir(path.join(home, 'sessions'));
    const write = (pid: number, data: object) => writeFile(path.join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, ...data }));
    await write(1, { sessionId: 'a', cwd: '/repo', entrypoint: 'claude-vscode', status: 'idle' });
    await write(2, { sessionId: 'b', cwd: '/repo/sub', entrypoint: 'cli' });
    await write(3, { sessionId: 'c', cwd: '/elsewhere', entrypoint: 'cli' });
    await write(4, { sessionId: 'd', cwd: '/repo', entrypoint: 'cli' });
    await writeFile(path.join(home, 'sessions', '5.json'), '{ half-written');

    const sessions = await listRunningSessions('/repo', new Set([1, 2, 3]), home);
    expect(sessions.map((s) => [s.pid, s.entrypoint]).sort()).toEqual([
      [1, 'claude-vscode'],
      [2, 'cli'],
    ]);
  });
});
