import * as vscode from 'vscode';
import { nextUnviewed, stepIndex, stepPosition, type Position } from '../core/navigation';
import { toRepoPath } from '../core/layout';
import type { ChangedFile } from '../core/diff';
import { sortThreads } from './commentsTree';
import type { CommentThreads } from './commentThreads';
import { diffUris, GIT_SCHEME } from './gitContent';
import type { ReviewModel } from './reviewModel';

/** Opening diffs and stepping through files and comments in review order. */
export class Navigator {
  /** The file most recently opened from the review, used when the active editor isn't one. */
  private currentPath: string | undefined;

  constructor(
    private readonly model: ReviewModel,
    private readonly comments: CommentThreads,
    /** Files in on-screen order (list vs tree layouts differ). */
    private readonly orderedFiles: () => ChangedFile[],
  ) {}

  async openFile(filePath: string): Promise<void> {
    const snapshot = this.model.snapshot;
    const file = snapshot?.files.find((f) => f.path === filePath);
    if (!snapshot || !file) return;
    this.currentPath = file.path;
    const { left, right, title } = diffUris(this.model.repo.git.root, snapshot, file);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  async stepFile(direction: 1 | -1): Promise<void> {
    const files = this.files();
    const index = stepIndex(files.length, this.currentIndex(files), direction);
    const file = index === undefined ? undefined : files[index];
    if (file) await this.openFile(file.path);
    else void vscode.window.showInformationMessage('No changed files in this scope.');
  }

  async markViewedAndNext(): Promise<void> {
    const files = this.files();
    const current = this.currentIndex(files);
    const file = files[current];
    if (file) await this.model.setViewed(file, true);
    const next = nextUnviewed(
      files.map((f) => this.model.isViewed(f)),
      current,
    );
    const target = next === undefined ? undefined : files[next];
    if (target) await this.openFile(target.path);
    else void vscode.window.showInformationMessage('All files in this scope are viewed.');
  }

  async toggleViewed(filePath?: string): Promise<void> {
    const files = this.files();
    const file = files.find((f) => f.path === filePath) ?? files[this.currentIndex(files)];
    if (file) await this.model.setViewed(file, !this.model.isViewed(file));
  }

  async stepComment(direction: 1 | -1): Promise<void> {
    const open = sortThreads(this.model.threads.filter((t) => t.status === 'open'));
    const target = stepPosition(open, this.cursor(), direction);
    if (target) await this.comments.reveal(target.id);
    else void vscode.window.showInformationMessage('No open review comments.');
  }

  /** Repo path of the active editor, whether it shows the real file or a git snapshot. */
  activePath(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri) return undefined;
    if (uri.scheme === 'file') return toRepoPath(this.model.repo.git.root, uri.fsPath);
    if (uri.scheme === GIT_SCHEME) return uri.path.replace(/^\//, '');
    return undefined;
  }

  /** The changed file shown in the active editor, if it is part of the current review. */
  activeFile(): ChangedFile | undefined {
    const path = this.activePath();
    return path === undefined ? undefined : this.files().find((f) => f.path === path);
  }

  async unmarkActiveViewed(): Promise<void> {
    const file = this.activeFile();
    if (file) await this.model.setViewed(file, false);
  }

  private files(): ChangedFile[] {
    return this.orderedFiles();
  }

  private currentIndex(files: readonly ChangedFile[]): number {
    const active = this.activePath();
    const byActive = files.findIndex((f) => f.path === active);
    return byActive >= 0 ? byActive : files.findIndex((f) => f.path === this.currentPath);
  }

  private cursor(): Position | undefined {
    const editor = vscode.window.activeTextEditor;
    const file = this.activePath();
    return editor && file ? { file, line: editor.selection.active.line + 1 } : undefined;
  }
}
