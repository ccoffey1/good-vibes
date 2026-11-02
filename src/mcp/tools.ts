import { CLAUDE_AUTHOR, isPending } from '../core/comments/model';
import { addReply, createThread, defaultOpsDeps, findThread, markSent, type OpsDeps } from '../core/comments/ops';
import { renderThreadsForAgent } from '../core/comments/render';
import { listChangedFiles, unifiedDiff } from '../core/diff';
import { toRepoPath } from '../core/layout';
import type { ReviewRepository } from '../core/repository';
import { resolveScope } from '../core/scopes';

/**
 * Tool implementations, independent of the MCP transport so they can be tested directly.
 * Each returns the text shown to Claude; validation problems are thrown as ToolInputError.
 */
export class ToolInputError extends Error {}

export interface ToolContext {
  repo: ReviewRepository;
  baseBranch?: string;
  deps?: OpsDeps;
}

export interface GetWorkspaceDiffInput {
  file?: string;
  stat?: boolean;
  scope?: 'branch' | 'uncommitted';
}

export async function getWorkspaceDiff(ctx: ToolContext, input: GetWorkspaceDiffInput): Promise<string> {
  const { git } = ctx.repo;
  const resolved = await resolveScope(git, { kind: input.scope ?? 'branch' }, { baseBranch: ctx.baseBranch, turns: [] });
  const paths = input.file ? [requireRepoPath(ctx, input.file)] : undefined;
  if (!input.stat && !paths) {
    // Guard against flooding the context window on large branches.
    const files = await listChangedFiles(git, resolved.left, resolved.right);
    const totalLines = files.reduce((sum, f) => sum + (f.additions ?? 0) + (f.deletions ?? 0), 0);
    if (totalLines > 4000) {
      const stat = await unifiedDiff(git, resolved.left, resolved.right, { stat: true });
      return `${resolved.label}: the full diff is ${totalLines} changed lines, too large to return at once. Request individual files with \`file\`.\n\n${stat}`;
    }
  }
  const diff = await unifiedDiff(git, resolved.left, resolved.right, { stat: input.stat, paths });
  return diff.trim() ? `${resolved.label}\n\n${diff}` : `${resolved.label}: no changes.`;
}

export interface GetDiffCommentsInput {
  file?: string;
  includeResolved?: boolean;
}

export async function getDiffComments(ctx: ToolContext, input: GetDiffCommentsInput): Promise<string> {
  const file = input.file ? requireRepoPath(ctx, input.file) : undefined;
  const { threads } = await ctx.repo.comments.read();
  const selected = threads.filter((t) => (!file || t.file === file) && (input.includeResolved || t.status === 'open'));
  if (selected.length === 0) return file ? `No review comments on ${file}.` : 'No review comments on the diff.';
  // Reading pending comments counts as delivering them to Claude.
  const pendingIds = selected.filter(isPending).map((t) => t.id);
  if (pendingIds.length > 0) {
    await ctx.repo.comments.update((data) => markSent(data, pendingIds, ctx.deps ?? defaultOpsDeps));
  }
  return renderThreadsForAgent(selected);
}

export interface DiffCommentInput {
  comments: Array<{ file: string; lineNumber: number; endLineNumber?: number; body: string }>;
}

export async function diffComment(ctx: ToolContext, input: DiffCommentInput): Promise<string> {
  if (input.comments.length === 0) throw new ToolInputError('Provide at least one comment.');
  const prepared = await Promise.all(
    input.comments.map(async (c) => {
      const file = requireRepoPath(ctx, c.file);
      const lines = await ctx.repo.readLines(file);
      if (!lines) throw new ToolInputError(`${file} does not exist in the working tree.`);
      if (c.lineNumber < 1 || c.lineNumber > lines.length) {
        throw new ToolInputError(`${file} has ${lines.length} lines; line ${c.lineNumber} is out of range.`);
      }
      if (!c.body.trim()) throw new ToolInputError(`Comment on ${file}:${c.lineNumber} has an empty body.`);
      return { ...c, file, lines };
    }),
  );
  const ids = await ctx.repo.comments.update((data) =>
    prepared.map(
      (c) =>
        createThread(
          data,
          { file: c.file, startLine: c.lineNumber, endLine: c.endLineNumber ?? c.lineNumber, author: CLAUDE_AUTHOR, body: c.body.trim(), fileLines: c.lines },
          ctx.deps,
        ).id,
    ),
  );
  return `Posted ${ids.length} comment(s) on the diff (thread ids: ${ids.join(', ')}).`;
}

export interface ReplyInput {
  threadId: string;
  body: string;
}

export async function replyToDiffComment(ctx: ToolContext, input: ReplyInput): Promise<string> {
  if (!input.body.trim()) throw new ToolInputError('Reply body is empty.');
  return ctx.repo.comments.update((data) => {
    if (!findThread(data, input.threadId)) throw new ToolInputError(`No comment thread with id ${input.threadId}.`);
    // Claude only replies; closing a thread is the user's call.
    addReply(data, input.threadId, CLAUDE_AUTHOR, input.body.trim(), ctx.deps);
    return 'Replied to the thread. The user will close it when satisfied.';
  });
}

function requireRepoPath(ctx: ToolContext, file: string): string {
  const path = toRepoPath(ctx.repo.git.root, file);
  if (!path) throw new ToolInputError(`${file} is outside the repository.`);
  return path;
}
