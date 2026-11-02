import { randomUUID } from 'node:crypto';
import { extractLines, reanchor, type AnchorRange } from './anchor';
import type { Author, CommentsFile, ReviewComment, ReviewThread } from './model';

/** Clock and id source, injected so operations are deterministic under test. */
export interface OpsDeps {
  now(): string;
  newId(): string;
}

export const defaultOpsDeps: OpsDeps = {
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

export interface NewThreadInput extends AnchorRange {
  file: string;
  author: Author;
  body: string;
  /** Current file lines, used to record the anchor text. */
  fileLines: readonly string[];
}

/** All operations mutate the given file in place (callers own it inside a store transaction). */
export function createThread(file: CommentsFile, input: NewThreadInput, deps: OpsDeps = defaultOpsDeps): ReviewThread {
  const now = deps.now();
  const range = clampRange(input, input.fileLines.length);
  const thread: ReviewThread = {
    id: deps.newId(),
    file: input.file,
    ...range,
    anchor: extractLines(input.fileLines, range),
    status: 'open',
    outdated: false,
    comments: [newComment(input.author, input.body, now, deps)],
    createdAt: now,
    updatedAt: now,
  };
  file.threads.push(thread);
  return thread;
}

export function addReply(file: CommentsFile, threadId: string, author: Author, body: string, deps: OpsDeps = defaultOpsDeps): ReviewComment {
  const thread = requireThread(file, threadId);
  const now = deps.now();
  const comment = newComment(author, body, now, deps);
  thread.comments.push(comment);
  thread.updatedAt = now;
  return comment;
}

export function editComment(file: CommentsFile, threadId: string, commentId: string, body: string, deps: OpsDeps = defaultOpsDeps): void {
  const thread = requireThread(file, threadId);
  const comment = thread.comments.find((c) => c.id === commentId);
  if (!comment) throw new Error(`Comment ${commentId} not found`);
  if (comment.body === body) return;
  const now = deps.now();
  comment.body = body;
  comment.editedAt = now;
  // An edited comment is new information for Claude.
  delete comment.sentAt;
  delete comment.queuedIn;
  thread.updatedAt = now;
}

/** Deletes a comment; deleting the last one deletes the thread. */
export function deleteComment(file: CommentsFile, threadId: string, commentId: string, deps: OpsDeps = defaultOpsDeps): void {
  const thread = requireThread(file, threadId);
  thread.comments = thread.comments.filter((c) => c.id !== commentId);
  if (thread.comments.length === 0) deleteThread(file, threadId);
  else thread.updatedAt = deps.now();
}

export function deleteThread(file: CommentsFile, threadId: string): void {
  file.threads = file.threads.filter((t) => t.id !== threadId);
}

export function setStatus(file: CommentsFile, threadId: string, status: ReviewThread['status'], deps: OpsDeps = defaultOpsDeps): void {
  const thread = requireThread(file, threadId);
  if (thread.status === status) return;
  thread.status = status;
  thread.updatedAt = deps.now();
}

/** Records that the threads' unsent user comments were put into Claude's input via `outboxPath`. */
export function markQueued(file: CommentsFile, threadIds: readonly string[], outboxPath: string): void {
  const ids = new Set(threadIds);
  for (const thread of file.threads) {
    if (!ids.has(thread.id)) continue;
    for (const comment of thread.comments) {
      if (comment.author.kind === 'user' && !comment.sentAt) comment.queuedIn = outboxPath;
    }
  }
}

/** Marks comments queued in any of `outboxPaths` as sent. Returns how many changed. */
export function markOutboxesSent(file: CommentsFile, outboxPaths: readonly string[], deps: OpsDeps = defaultOpsDeps): number {
  const paths = new Set(outboxPaths);
  const now = deps.now();
  let changed = 0;
  for (const thread of file.threads) {
    for (const comment of thread.comments) {
      if (!comment.queuedIn || !paths.has(comment.queuedIn)) continue;
      comment.sentAt = now;
      delete comment.queuedIn;
      changed++;
    }
  }
  return changed;
}

/** Outbox files @-mentioned in a submitted prompt. */
export function outboxMentions(prompt: string): string[] {
  return [...prompt.matchAll(/\.good-vibes\/outbox\/[\w.-]+\.md/g)].map((m) => m[0]);
}

/** Marks every user comment in the given threads as sent. */
export function markSent(file: CommentsFile, threadIds: readonly string[], deps: OpsDeps = defaultOpsDeps): void {
  const now = deps.now();
  const ids = new Set(threadIds);
  for (const thread of file.threads) {
    if (!ids.has(thread.id)) continue;
    for (const comment of thread.comments) {
      if (comment.author.kind === 'user' && !comment.sentAt) {
        comment.sentAt = now;
        delete comment.queuedIn;
      }
    }
  }
}

/** Re-anchors every thread on `path` against its current lines. Returns true if anything changed. */
export function reanchorFile(file: CommentsFile, path: string, lines: readonly string[], deps: OpsDeps = defaultOpsDeps): boolean {
  let changed = false;
  for (const thread of file.threads) {
    if (thread.file !== path) continue;
    const next = reanchor(lines, thread, thread.anchor);
    if (next.startLine === thread.startLine && next.endLine === thread.endLine && next.outdated === thread.outdated) continue;
    Object.assign(thread, next, { updatedAt: deps.now() });
    changed = true;
  }
  return changed;
}

export function findThread(file: CommentsFile, threadId: string): ReviewThread | undefined {
  return file.threads.find((t) => t.id === threadId);
}

function requireThread(file: CommentsFile, threadId: string): ReviewThread {
  const thread = findThread(file, threadId);
  if (!thread) throw new Error(`Comment thread ${threadId} not found`);
  return thread;
}

function newComment(author: Author, body: string, now: string, deps: OpsDeps): ReviewComment {
  return { id: deps.newId(), author, body, createdAt: now };
}

function clampRange(range: AnchorRange, lineCount: number): AnchorRange {
  const last = Math.max(1, lineCount);
  const startLine = Math.min(Math.max(1, Math.min(range.startLine, range.endLine)), last);
  const endLine = Math.min(Math.max(startLine, range.startLine, range.endLine), last);
  return { startLine, endLine };
}
