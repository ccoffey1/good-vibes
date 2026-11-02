import { z } from 'zod';

/** On-disk schema for `.good-vibes/comments.json`, shared by the extension and the MCP server. */
export const AuthorSchema = z.object({
  kind: z.enum(['user', 'agent']),
  name: z.string(),
});

export const ReviewCommentSchema = z.object({
  id: z.string(),
  author: AuthorSchema,
  body: z.string(),
  createdAt: z.string(),
  editedAt: z.string().optional(),
  /**
   * Repo-relative outbox file whose @-mention was put into Claude's input. Not yet sent: the user
   * can still delete the mention. Cleared once the prompt is submitted (see `sentAt`).
   */
  queuedIn: z.string().optional(),
  /** When Claude actually received this comment (prompt submitted, or read via MCP). User comments only. */
  sentAt: z.string().optional(),
});

export const ReviewThreadSchema = z.object({
  id: z.string(),
  /** Repo-relative POSIX path. */
  file: z.string(),
  /** 1-based, inclusive. */
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  /** Text of the commented lines when the thread was created; used to follow code as it moves. */
  anchor: z.string(),
  status: z.enum(['open', 'resolved']),
  /** The anchored code can no longer be found in the file. */
  outdated: z.boolean(),
  comments: z.array(ReviewCommentSchema).min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CommentsFileSchema = z.object({
  version: z.literal(1),
  threads: z.array(ReviewThreadSchema),
});

export type Author = z.infer<typeof AuthorSchema>;
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type ReviewThread = z.infer<typeof ReviewThreadSchema>;
export type CommentsFile = z.infer<typeof CommentsFileSchema>;

export const USER_AUTHOR: Author = { kind: 'user', name: 'You' };
export const CLAUDE_AUTHOR: Author = { kind: 'agent', name: 'Claude' };

export function emptyCommentsFile(): CommentsFile {
  return { version: 1, threads: [] };
}

/** A thread is pending when it has user comments Claude hasn't been sent yet. */
export function isPending(thread: ReviewThread): boolean {
  return thread.status === 'open' && thread.comments.some((c) => c.author.kind === 'user' && !c.sentAt);
}
