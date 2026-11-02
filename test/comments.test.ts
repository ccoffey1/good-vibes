import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { reanchor } from '../src/core/comments/anchor';
import { CLAUDE_AUTHOR, emptyCommentsFile, isPending, USER_AUTHOR } from '../src/core/comments/model';
import { addReply, createThread, deleteComment, editComment, markSent, reanchorFile, type OpsDeps } from '../src/core/comments/ops';
import { renderOutbox } from '../src/core/comments/render';
import { CommentStore } from '../src/core/comments/store';

function fakeDeps(): OpsDeps {
  let id = 0;
  return { now: () => '2026-01-01T00:00:00.000Z', newId: () => `id${++id}` };
}

const LINES = ['a', 'b', 'c', 'd', 'e'];

describe('reanchor', () => {
  it('keeps a range whose text is unchanged', () => {
    expect(reanchor(LINES, { startLine: 2, endLine: 3 }, 'b\nc')).toEqual({ startLine: 2, endLine: 3, outdated: false });
  });

  it('follows code that moved, preferring the closest match', () => {
    const moved = ['x', 'b', 'c', 'y', 'y', 'y', 'b', 'c'];
    expect(reanchor(moved, { startLine: 3, endLine: 4 }, 'b\nc')).toEqual({ startLine: 2, endLine: 3, outdated: false });
  });

  it('marks outdated when the code is gone, clamped to the file', () => {
    expect(reanchor(['only'], { startLine: 4, endLine: 5 }, 'gone')).toEqual({ startLine: 1, endLine: 1, outdated: true });
  });
});

describe('comment operations', () => {
  it('tracks pending state through send, reply, and edit', () => {
    const deps = fakeDeps();
    const file = emptyCommentsFile();
    const thread = createThread(file, { file: 'a.ts', startLine: 2, endLine: 3, author: USER_AUTHOR, body: 'why?', fileLines: LINES }, deps);
    expect(thread.anchor).toBe('b\nc');
    expect(isPending(thread)).toBe(true);

    markSent(file, [thread.id], deps);
    expect(isPending(thread)).toBe(false);

    addReply(file, thread.id, CLAUDE_AUTHOR, 'because', deps);
    expect(isPending(thread)).toBe(false);

    const firstId = thread.comments[0]!.id;
    editComment(file, thread.id, firstId, 'why though?', deps);
    expect(isPending(thread)).toBe(true);
  });

  it('agent-only threads are never pending; deleting the last comment deletes the thread', () => {
    const deps = fakeDeps();
    const file = emptyCommentsFile();
    const thread = createThread(file, { file: 'a.ts', startLine: 1, endLine: 1, author: CLAUDE_AUTHOR, body: 'bug here', fileLines: LINES }, deps);
    expect(isPending(thread)).toBe(false);
    deleteComment(file, thread.id, thread.comments[0]!.id, deps);
    expect(file.threads).toEqual([]);
  });

  it('clamps ranges to the file and normalizes reversed ranges', () => {
    const file = emptyCommentsFile();
    const thread = createThread(file, { file: 'a.ts', startLine: 9, endLine: 4, author: USER_AUTHOR, body: 'x', fileLines: LINES }, fakeDeps());
    expect([thread.startLine, thread.endLine]).toEqual([4, 5]);
  });

  it('re-anchors only threads on the given file', () => {
    const deps = fakeDeps();
    const file = emptyCommentsFile();
    const a = createThread(file, { file: 'a.ts', startLine: 3, endLine: 3, author: USER_AUTHOR, body: 'x', fileLines: LINES }, deps);
    const b = createThread(file, { file: 'b.ts', startLine: 3, endLine: 3, author: USER_AUTHOR, body: 'x', fileLines: LINES }, deps);
    expect(reanchorFile(file, 'a.ts', ['new', ...LINES], deps)).toBe(true);
    expect(a.startLine).toBe(4);
    expect(b.startLine).toBe(3);
    expect(reanchorFile(file, 'a.ts', ['new', ...LINES], deps)).toBe(false);
  });
});

describe('renderOutbox', () => {
  it('includes location, thread id, a marked code excerpt, and the conversation', async () => {
    const file = emptyCommentsFile();
    const thread = createThread(file, { file: 'src/a.ts', startLine: 3, endLine: 3, author: USER_AUTHOR, body: 'rename this', fileLines: LINES }, fakeDeps());
    const markdown = await renderOutbox([thread], async () => LINES);
    expect(markdown).toContain('## 1. src/a.ts:3');
    expect(markdown).toContain(`Thread id: \`${thread.id}\``);
    expect(markdown).toContain('> 3 | c');
    expect(markdown).toContain('  2 | b');
    expect(markdown).toContain('**Me**: rename this');
  });
});

describe('CommentStore', () => {
  it('serializes concurrent updates without losing writes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'good-vibes-store-'));
    const store = new CommentStore(path.join(dir, 'comments.json'), path.join(dir, 'comments.lock'));
    const other = new CommentStore(path.join(dir, 'comments.json'), path.join(dir, 'comments.lock'));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? store : other).update((data) => {
          createThread(data, { file: `f${i}.ts`, startLine: 1, endLine: 1, author: USER_AUTHOR, body: String(i), fileLines: ['x'] });
        }),
      ),
    );
    expect((await store.read()).threads).toHaveLength(20);
  });

  it('rejects a malformed file instead of silently discarding it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'good-vibes-store-'));
    const filePath = path.join(dir, 'comments.json');
    await import('node:fs/promises').then((fs) => fs.writeFile(filePath, '{"version":2}'));
    await expect(new CommentStore(filePath, path.join(dir, 'lock')).read()).rejects.toThrow(/not a valid comments file/);
  });
});
