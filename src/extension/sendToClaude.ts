import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isPending, type ReviewThread } from '../core/comments/model';
import { markQueued } from '../core/comments/ops';
import { renderOutbox } from '../core/comments/render';
import { toRepoPath } from '../core/layout';
import { chooseTarget, deliverMention, type Delivery } from './claudeTargets';
export type { Delivery };
import type { ReviewModel } from './reviewModel';

export interface SendOptions {
  /** Show the session picker even when a session is already selected. */
  pickSession?: boolean;
}

/**
 * Hands review threads to Claude: picks a session, renders the threads into a markdown file under
 * `.good-vibes/outbox/`, marks the user comments queued, and puts an @-mention of that file into the
 * session's input for the user to submit.
 */
export async function sendToClaude(model: ReviewModel, threads: readonly ReviewThread[], delivery: Delivery, options: SendOptions = {}): Promise<void> {
  if (threads.length === 0) {
    void vscode.window.showInformationMessage('No pending review comments to send.');
    return;
  }
  await model.reloadTurns();
  // Choose first: dismissing the picker must leave the comments pending.
  const target = await chooseTarget(delivery, model.repo.git.root, model.turns, options.pickSession);
  if (!target) return;

  const markdown = await renderOutbox(threads, model.repo.readLines);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outboxFile = path.join(model.repo.layout.outboxDir, `review-${stamp}.md`);
  await writeFile(outboxFile, markdown);
  const outboxPath = toRepoPath(model.repo.git.root, outboxFile) ?? outboxFile;
  // "Queued", not sent: the user may still delete the mention. The prompt-submit hook marks them sent.
  await model.repo.comments.update((data) => markQueued(data, threads.map((t) => t.id), outboxPath));
  await model.reloadComments();

  const mention = `@${outboxPath}`;
  const where = await deliverMention(target, mention, vscode.Uri.file(outboxFile));
  const count = `${threads.length} comment${threads.length === 1 ? '' : 's'}`;
  // A transient status-bar note rather than a toast: sending should feel like it just happened.
  vscode.window.setStatusBarMessage(
    target.kind === 'clipboard' ? `$(clippy) Copied ${count} for Claude. Paste into Claude Code.` : `$(check) Added ${count} to ${where}`,
    5000,
  );
}

export function pendingThreads(model: ReviewModel): ReviewThread[] {
  return model.threads.filter(isPending);
}
