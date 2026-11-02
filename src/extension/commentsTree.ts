import * as path from 'node:path';
import * as vscode from 'vscode';
import { isPending, type ReviewThread } from '../core/comments/model';
import { formatRange } from '../core/comments/render';
import type { ReviewModel } from './reviewModel';

type Node = GroupItem | ThreadItem;

class GroupItem extends vscode.TreeItem {
  constructor(
    readonly key: 'open' | 'resolved',
    readonly threads: ReviewThread[],
  ) {
    super(key === 'open' ? 'Open' : 'Closed', key === 'open' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `group:${key}`;
    this.description = String(threads.length);
  }
}

export class ThreadItem extends vscode.TreeItem {
  constructor(
    readonly thread: ReviewThread,
    root: string,
  ) {
    const first = thread.comments[0];
    const last = thread.comments.at(-1);
    super(firstLine(first?.body ?? ''), vscode.TreeItemCollapsibleState.None);
    this.id = thread.id;
    const pending = isPending(thread);
    const tags = [pending ? 'pending' : '', thread.outdated ? 'outdated' : '', thread.comments.length > 1 ? `${thread.comments.length} comments` : '']
      .filter(Boolean)
      .join(', ');
    this.description = `${path.posix.basename(thread.file)}:${formatRange(thread)}${tags ? ` · ${tags}` : ''}`;
    this.tooltip = new vscode.MarkdownString(
      thread.comments.map((c) => `**${c.author.name}**: ${c.body}`).join('\n\n---\n\n') + `\n\n_${thread.file}:${formatRange(thread)}_`,
    );
    this.iconPath = new vscode.ThemeIcon(
      thread.status === 'resolved' ? 'pass' : last?.author.kind === 'agent' ? 'sparkle' : pending ? 'comment-draft' : 'comment',
    );
    this.resourceUri = vscode.Uri.file(path.join(root, thread.file));
    this.contextValue = `thread-${thread.status}`;
    this.command = { command: 'goodVibes.revealThread', title: 'Go to Comment', arguments: [thread.id] };
  }
}

/** Review threads ordered by file and line; closed ones are grouped under "Closed" once there are any. */
export class CommentsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly model: ReviewModel) {}

  fire(): void {
    this.changed.fire();
  }

  getTreeItem(item: Node): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: Node): Node[] {
    const root = this.model.repo.git.root;
    if (parent instanceof GroupItem) return parent.threads.map((t) => new ThreadItem(t, root));
    if (parent) return [];
    const sorted = sortThreads(this.model.threads);
    const open = sorted.filter((t) => t.status === 'open');
    const closed = sorted.filter((t) => t.status === 'resolved');
    if (closed.length === 0) return open.map((t) => new ThreadItem(t, root));
    return [new GroupItem('open', open), new GroupItem('resolved', closed)];
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export function sortThreads(threads: readonly ReviewThread[]): ReviewThread[] {
  return [...threads].sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
