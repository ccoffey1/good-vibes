import { describe, expect, it } from 'vitest';
import { handleHookEvent } from '../src/hook/turnRecorder';
import { openRepository } from '../src/core/repository';
import { readTurns } from '../src/core/turns';
import { diffComment, getDiffComments, getWorkspaceDiff, replyToDiffComment, ToolInputError } from '../src/mcp/tools';
import { createThread, markQueued } from '../src/core/comments/ops';
import { USER_AUTHOR } from '../src/core/comments/model';
import { createRepo } from './helpers';

describe('turn hook', () => {
  it('records a turn from prompt submit to stop with checkpoints at both ends', async () => {
    const repo = await createRepo({ 'a.txt': 'one\n' });
    const base = { session_id: 's1', cwd: repo.root };
    const start = await handleHookEvent({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'change a' });
    expect(start.kind).toBe('recorded');
    await repo.write('a.txt', 'two\n');
    expect((await handleHookEvent({ ...base, hook_event_name: 'Stop' })).kind).toBe('recorded');
    expect((await handleHookEvent({ ...base, hook_event_name: 'Stop' })).kind).toBe('skipped');

    const opened = await openRepository(repo.root);
    const [turn] = await readTurns(opened!.layout.turnsFile);
    expect(turn).toMatchObject({ sessionId: 's1', prompt: 'change a' });
    expect(repo.git('diff', '--name-only', turn!.startRef, turn!.endRef!).trim()).toBe('a.txt');
  });

  it('marks comments sent only when a prompt mentioning their outbox file is submitted', async () => {
    const repo = await createRepo({ 'a.txt': 'one\n' });
    const opened = (await openRepository(repo.root))!;
    const outbox = '.good-vibes/outbox/review-1.md';
    await opened.comments.update((data) => {
      const t = createThread(data, { file: 'a.txt', startLine: 1, endLine: 1, author: USER_AUTHOR, body: 'hm', fileLines: ['one'] });
      markQueued(data, [t.id], outbox);
    });
    const base = { session_id: 's1', cwd: repo.root, hook_event_name: 'UserPromptSubmit' };
    await handleHookEvent({ ...base, prompt: 'unrelated prompt' });
    const before = (await opened.comments.read()).threads[0]?.comments[0];
    expect(before?.queuedIn).toBe(outbox);
    expect(before?.sentAt).toBeUndefined();
    await handleHookEvent({ ...base, prompt: `@${outbox} please` });
    const comment = (await opened.comments.read()).threads[0]?.comments[0];
    expect(comment?.sentAt).toBeDefined();
    expect(comment?.queuedIn).toBeUndefined();
  });

  it('skips directories outside git', async () => {
    const result = await handleHookEvent({ hook_event_name: 'Stop', session_id: 's', cwd: '/' });
    expect(result.kind).toBe('skipped');
  });
});

describe('MCP tools', () => {
  async function setup() {
    const repo = await createRepo({ 'src/a.ts': 'const a = 1;\nconst b = 2;\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    await repo.write('src/a.ts', 'const a = 1;\nconst b = 3;\n');
    const opened = (await openRepository(repo.root))!;
    return { repo, ctx: { repo: opened } };
  }

  it('GetWorkspaceDiff returns the branch diff, a stat, or one file', async () => {
    const { ctx, repo } = await setup();
    expect(await getWorkspaceDiff(ctx, {})).toContain('+const b = 3;');
    expect(await getWorkspaceDiff(ctx, { stat: true })).toMatch(/src\/a\.ts \| 2/);
    expect(await getWorkspaceDiff(ctx, { file: `${repo.root}/src/a.ts` })).toContain('-const b = 2;');
  });

  it('DiffComment validates and posts agent threads; replies never close threads', async () => {
    const { ctx } = await setup();
    await expect(diffComment(ctx, { comments: [{ file: 'src/a.ts', lineNumber: 99, body: 'x' }] })).rejects.toBeInstanceOf(ToolInputError);
    await expect(diffComment(ctx, { comments: [{ file: '../etc/passwd', lineNumber: 1, body: 'x' }] })).rejects.toThrow(/outside the repository/);

    expect(await diffComment(ctx, { comments: [{ file: 'src/a.ts', lineNumber: 2, body: 'b changed' }] })).toMatch(/Posted 1 comment/);
    const [thread] = (await ctx.repo.comments.read()).threads;
    expect(thread).toMatchObject({ file: 'src/a.ts', startLine: 2, anchor: 'const b = 3;', comments: [{ author: { kind: 'agent' } }] });

    await replyToDiffComment(ctx, { threadId: thread!.id, body: 'fixed' });
    const after = (await ctx.repo.comments.read()).threads[0];
    expect(after?.status).toBe('open');
    expect(after?.comments.at(-1)).toMatchObject({ author: { kind: 'agent' }, body: 'fixed' });
  });

  it('GetDiffComments marks pending user comments as sent', async () => {
    const { ctx } = await setup();
    await ctx.repo.comments.update((data) =>
      createThread(data, { file: 'src/a.ts', startLine: 1, endLine: 1, author: USER_AUTHOR, body: 'rename a', fileLines: ['const a = 1;'] }),
    );
    expect(await getDiffComments(ctx, { file: 'src/a.ts' })).toContain('[user] rename a');
    expect((await ctx.repo.comments.read()).threads[0]?.comments[0]?.sentAt).toBeDefined();
  });
});
