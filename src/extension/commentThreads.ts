import * as path from 'node:path';
import * as vscode from 'vscode';
import { splitLines } from '../core/comments/anchor';
import { USER_AUTHOR, type CommentsFile, type ReviewComment, type ReviewThread } from '../core/comments/model';
import { addReply, createThread, deleteThread, editComment, reanchorFile, setStatus } from '../core/comments/ops';
import { languageForFile, tagCodeFences } from '../core/comments/markdown';
import { STATE_DIR_NAME, toRepoPath } from '../core/layout';
import type { ReviewModel } from './reviewModel';

export const CONTROLLER_ID = 'good-vibes';

class VsComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  contextValue?: string;
  timestamp: Date;

  constructor(
    readonly threadId: string,
    readonly source: ReviewComment,
    file: string,
  ) {
    // Claude's untagged code blocks get the file's language so they're syntax-highlighted. User
    // comments are left verbatim because their body is what the edit box shows.
    this.body = new vscode.MarkdownString(source.author.kind === 'agent' ? tagCodeFences(source.body, languageForFile(file)) : source.body);
    this.author = { name: source.author.name };
    this.timestamp = new Date(source.editedAt ?? source.createdAt);
    if (source.author.kind === 'user') {
      this.contextValue = source.sentAt ? 'editable' : 'editable-unsent';
    } else {
      this.contextValue = 'agent';
    }
  }
}

/**
 * Renders review threads inline in editors (gutter "+" to add, replies, edit, resolve) and keeps
 * them in sync with the comment store, which Claude's MCP server also writes to.
 */
export class CommentThreads implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly model: ReviewModel) {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Good Vibes Review');
    // VS Code renders the input placeholder without a font-family (serif fallback), and an empty
    // string falls back to its default text, so a single space hides it entirely.
    this.controller.options = { prompt: 'Reply', placeHolder: ' ' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => (this.repoPath(document.uri) ? [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)] : []),
    };
    this.disposables.push(
      this.controller,
      model.onDidChangeComments(() => this.render()),
      vscode.workspace.onDidSaveTextDocument((document) => void this.reanchor(document)),
    );
  }

  /** Creates a thread from the gutter's empty-thread input. Returns its id. */
  async create(reply: vscode.CommentReply): Promise<string | undefined> {
    const file = this.repoPath(reply.thread.uri);
    const range = reply.thread.range;
    if (!file || !range || !reply.text.trim()) return undefined;
    const document = await vscode.workspace.openTextDocument(reply.thread.uri);
    const fileLines = splitLines(document.getText());
    reply.thread.dispose();
    const thread = await this.mutate((data) =>
      createThread(data, { file, startLine: range.start.line + 1, endLine: range.end.line + 1, author: USER_AUTHOR, body: reply.text.trim(), fileLines }),
    );
    return thread?.id;
  }

  /** Adds the text typed in a thread's reply box as a reply. Returns the thread id. */
  async reply(reply: vscode.CommentReply): Promise<string | undefined> {
    const id = this.ids.get(reply.thread);
    if (!id || !reply.text.trim()) return undefined;
    await this.mutate((data) => {
      addReply(data, id, USER_AUTHOR, reply.text.trim());
      // Replying reopens a closed conversation.
      setStatus(data, id, 'open');
    });
    return id;
  }

  async setStatus(target: ThreadTarget, status: ReviewThread['status']): Promise<void> {
    const id = this.resolveTarget(target);
    if (id) await this.mutate((data) => setStatus(data, id, status));
  }

  async deleteThread(target: ThreadTarget): Promise<void> {
    const id = this.resolveTarget(target);
    if (!id) return;
    const answer = await vscode.window.showWarningMessage('Delete this comment thread?', { modal: true }, 'Delete');
    if (answer === 'Delete') await this.mutate((data) => deleteThread(data, id));
  }

  startEdit(comment: VsComment): void {
    this.setMode(comment, vscode.CommentMode.Editing);
  }

  cancelEdit(comment: VsComment): void {
    this.render();
    this.setMode(comment, vscode.CommentMode.Preview);
  }

  async saveEdit(comment: VsComment): Promise<void> {
    const body = typeof comment.body === 'string' ? comment.body : comment.body.value;
    if (!body.trim()) return;
    await this.mutate((data) => editComment(data, comment.threadId, comment.source.id, body.trim()));
  }

  /** Opens the thread's file and expands the thread. */
  async reveal(threadId: string): Promise<void> {
    const thread = this.model.threads.find((t) => t.id === threadId);
    if (!thread) return;
    const uri = vscode.Uri.file(path.join(this.model.repo.git.root, thread.file));
    const range = new vscode.Range(thread.startLine - 1, 0, thread.endLine - 1, 0);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(range.start, range.start), preview: true });
    const vsThread = this.threads.get(threadId);
    if (vsThread) vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  resolveTarget(target: ThreadTarget): string | undefined {
    return typeof target === 'string' ? target : this.ids.get(target);
  }

  dispose(): void {
    for (const thread of this.threads.values()) thread.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private render(): void {
    const seen = new Set<string>();
    // Closed threads leave the editor entirely; they live on only in the sidebar's Closed group.
    for (const thread of this.model.threads.filter((t) => t.status === 'open')) {
      seen.add(thread.id);
      const uri = vscode.Uri.file(path.join(this.model.repo.git.root, thread.file));
      const range = new vscode.Range(thread.startLine - 1, 0, thread.endLine - 1, 0);
      let vsThread = this.threads.get(thread.id);
      // You don't reply to yourself: the reply box appears only once Claude has the last word.
      const canReply = thread.comments.at(-1)?.author.kind === 'agent';
      // Flipping canReply on a live widget makes VS Code render a second reply form, so recreate it.
      if (vsThread && (vsThread.uri.toString() !== uri.toString() || vsThread.canReply !== canReply)) {
        vsThread.dispose();
        vsThread = undefined;
      }
      if (!vsThread) {
        vsThread = this.controller.createCommentThread(uri, range, []);
        vsThread.collapsibleState =
          thread.status === 'open' ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
        this.threads.set(thread.id, vsThread);
        this.ids.set(vsThread, thread.id);
      }
      vsThread.range = range;
      vsThread.comments = thread.comments.map((c) => new VsComment(thread.id, c, thread.file));
      vsThread.canReply = canReply;
      vsThread.contextValue = thread.status;
      vsThread.state = thread.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      vsThread.label = threadLabel(thread);
    }
    for (const [id, vsThread] of this.threads) {
      if (seen.has(id)) continue;
      vsThread.dispose();
      this.threads.delete(id);
    }
  }

  private setMode(comment: VsComment, mode: vscode.CommentMode): void {
    const vsThread = this.threads.get(comment.threadId);
    if (!vsThread) return;
    vsThread.comments = vsThread.comments.map((c) => {
      if (c instanceof VsComment && c.source.id === comment.source.id) c.mode = mode;
      return c;
    });
  }

  private async reanchor(document: vscode.TextDocument): Promise<void> {
    const file = this.repoPath(document.uri);
    if (!file || !this.model.threads.some((t) => t.file === file)) return;
    const lines = splitLines(document.getText());
    let changed = false;
    await this.model.repo.comments.update((data) => {
      changed = reanchorFile(data, file, lines);
    });
    if (changed) await this.model.reloadComments();
  }

  private async mutate<T>(change: (data: CommentsFile) => T): Promise<T | undefined> {
    try {
      const result = await this.model.repo.comments.update(change);
      await this.model.reloadComments();
      return result;
    } catch (error) {
      void vscode.window.showErrorMessage(`Good Vibes: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private repoPath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;
    const file = toRepoPath(this.model.repo.git.root, uri.fsPath);
    return file && !file.startsWith(`${STATE_DIR_NAME}/`) ? file : undefined;
  }
}

/** Thread commands receive the inline widget's thread, or a thread id (from the Comments tree). */
export type ThreadTarget = vscode.CommentThread | string;

export { VsComment };

function threadLabel(thread: ReviewThread): string {
  const parts: string[] = [];
  if (thread.comments[0]?.author.kind === 'agent') parts.push('Claude review');
  if (thread.outdated) parts.push('outdated');
  if (thread.status === 'resolved') parts.push('closed');
  return parts.join(' · ') || 'Review comment';
}
