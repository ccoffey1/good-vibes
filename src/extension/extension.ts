import * as path from 'node:path';
import * as vscode from 'vscode';
import { isPending } from '../core/comments/model';
import { openRepository } from '../core/repository';
import { summarizePrompt } from '../core/scopes';
import { ChangesTreeProvider, FileItem, type FileLayout } from './changesTree';
import { CommentThreads, VsComment, type ThreadTarget } from './commentThreads';
import { CommentsTreeProvider, ThreadItem } from './commentsTree';
import { GIT_SCHEME, GitContentProvider } from './gitContent';
import { Navigator } from './navigation';
import { ReviewModel } from './reviewModel';
import { pickScope } from './scopePicker';
import type { Delivery } from './claudeTargets';
import { pendingThreads, sendToClaude, type SendOptions } from './sendToClaude';
import { connectClaude, installScripts, offerToConnect } from './setup';

const FILE_REFRESH_DELAY_MS = 600;
const COMMENT_RELOAD_DELAY_MS = 100;

/** Returned from `activate` so integration tests can inspect state. Not a stable public API. */
export interface GoodVibesApi {
  model: ReviewModel;
}

export async function activate(context: vscode.ExtensionContext): Promise<GoodVibesApi | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') return;
  const repo = await openRepository(folder.uri.fsPath);
  if (!repo) return;

  const config = () => vscode.workspace.getConfiguration('goodVibes');
  const model = new ReviewModel(repo, () => config().get<string>('baseBranch') || undefined, context.workspaceState);
  const comments = new CommentThreads(model);
  const changes = new ChangesTreeProvider(model, context.workspaceState);
  const navigator = new Navigator(model, comments, () => changes.orderedFiles());
  const commentsTree = new CommentsTreeProvider(model);
  const changesView = vscode.window.createTreeView('goodVibes.changes', { treeDataProvider: changes, manageCheckboxStateManually: true });
  const commentsView = vscode.window.createTreeView('goodVibes.comments', { treeDataProvider: commentsTree });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'goodVibes.sendToClaude';

  const updateViews = () => {
    const snapshot = model.snapshot;
    changesView.description = snapshot?.resolved.label;
    changesView.message = model.lastError ? `Couldn't compute the diff: ${model.lastError}` : undefined;
    const pending = model.threads.filter(isPending).length;
    commentsView.badge = pending > 0 ? { value: pending, tooltip: `${pending} pending comment thread(s)` } : undefined;
    commentsView.description = pending > 0 ? `${pending} pending` : undefined;
    statusBar.text = `$(send) ${pending} for Claude`;
    statusBar.tooltip = 'Send pending review comments to Claude';
    if (pending > 0) statusBar.show();
    else statusBar.hide();
  };

  /** Drives the editor-title "viewed" toggle, which VS Code can only show/hide via context keys. */
  const syncEditorContext = () => {
    const file = navigator.activeFile();
    void setContext('goodVibes.reviewing', file !== undefined);
    void setContext('goodVibes.activeFileViewed', file !== undefined && model.isViewed(file));
  };

  const setLayout = async (layout: FileLayout) => {
    await changes.setLayout(layout);
    await setContext('goodVibes.fileLayout', layout);
  };

  const refreshFiles = debounce(() => void model.refresh(), FILE_REFRESH_DELAY_MS);
  const reloadComments = debounce(() => void model.reloadComments().catch(showError), COMMENT_RELOAD_DELAY_MS);
  const commentsFile = path.normalize(repo.layout.commentsFile);
  const turnsFile = path.normalize(repo.layout.turnsFile);
  const stateDir = `${path.normalize(repo.layout.dir)}${path.sep}`;
  const onFsEvent = (uri: vscode.Uri) => {
    const fsPath = path.normalize(uri.fsPath);
    if (fsPath === commentsFile) reloadComments();
    else if (fsPath === turnsFile) refreshFiles();
    else if (!fsPath.startsWith(stateDir)) refreshFiles();
  };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));

  const thread = (target: ThreadTarget | ThreadItem): ThreadTarget => (target instanceof ThreadItem ? target.thread.id : target);
  const delivery = () => config().get<Delivery>('delivery') ?? 'auto';
  const sendIds = (ids: ReadonlyArray<string | undefined>, options?: SendOptions) =>
    sendToClaude(model, model.threads.filter((t) => ids.includes(t.id)), delivery(), options);
  const command = (id: string, handler: (...args: never[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: never[]) => {
      try {
        await handler(...args);
      } catch (error) {
        showError(error);
      }
    });

  context.subscriptions.push(
    comments,
    changes,
    commentsTree,
    changesView,
    commentsView,
    statusBar,
    watcher,
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider(repo.git)),
    watcher.onDidChange(onFsEvent),
    watcher.onDidCreate(onFsEvent),
    watcher.onDidDelete(onFsEvent),
    vscode.window.onDidChangeWindowState((state) => state.focused && refreshFiles()),
    vscode.window.onDidChangeActiveTextEditor(syncEditorContext),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('goodVibes.baseBranch') && refreshFiles()),
    model.onDidChangeFiles(() => {
      changes.fire();
      updateViews();
      syncEditorContext();
    }),
    model.onDidChangeComments(() => {
      commentsTree.fire();
      changes.fire();
      updateViews();
    }),
    model.onDidEndTurn((turn) => {
      if (!config().get<boolean>('notifyOnTurnEnd')) return;
      void vscode.window.showInformationMessage(`Claude finished: “${summarizePrompt(turn.prompt, 50)}”`, 'Review Turn').then((choice) => {
        if (choice) void model.setScope({ kind: 'turn', turnId: turn.id }).then(() => vscode.commands.executeCommand('goodVibes.changes.focus'));
      });
    }),
    changesView.onDidChangeCheckboxState(async (event) => {
      for (const [item, state] of event.items) {
        if (item instanceof FileItem) await model.setViewed(item.file, state === vscode.TreeItemCheckboxState.Checked);
      }
    }),

    command('goodVibes.refresh', () => model.refresh()),
    command('goodVibes.viewAsTree', () => setLayout('tree')),
    command('goodVibes.viewAsList', () => setLayout('list')),
    command('goodVibes.pickScope', async () => {
      const scope = await pickScope(model, config().get<string>('baseBranch') || undefined);
      if (scope) await model.setScope(scope);
    }),
    command('goodVibes.openFile', (filePath: string) => navigator.openFile(filePath)),
    command('goodVibes.nextFile', () => navigator.stepFile(1)),
    command('goodVibes.previousFile', () => navigator.stepFile(-1)),
    command('goodVibes.markViewedAndNext', () => navigator.markViewedAndNext()),
    command('goodVibes.unmarkViewed', () => navigator.unmarkActiveViewed()),
    command('goodVibes.toggleViewed', (item?: FileItem) => navigator.toggleViewed(item?.file.path)),
    command('goodVibes.nextComment', () => navigator.stepComment(1)),
    command('goodVibes.previousComment', () => navigator.stepComment(-1)),
    command('goodVibes.revealThread', (id: string) => comments.reveal(id)),
    command('goodVibes.createThread', (reply: vscode.CommentReply) => comments.create(reply)),
    command('goodVibes.createAndAddToChat', async (reply: vscode.CommentReply) => sendIds([await comments.create(reply)])),
    command('goodVibes.reply', (reply: vscode.CommentReply) => comments.reply(reply)),
    command('goodVibes.replyAndAddToChat', async (reply: vscode.CommentReply) => sendIds([await comments.reply(reply)])),
    command('goodVibes.replyAndAddToChatChoose', async (reply: vscode.CommentReply) => sendIds([await comments.reply(reply)], { pickSession: true })),
    command('goodVibes.createAndAddToChatChoose', async (reply: vscode.CommentReply) => sendIds([await comments.create(reply)], { pickSession: true })),
    command('goodVibes.closeThread', (target: ThreadTarget | ThreadItem) => comments.setStatus(thread(target), 'resolved')),
    command('goodVibes.reopenThread', (target: ThreadTarget | ThreadItem) => comments.setStatus(thread(target), 'open')),
    command('goodVibes.deleteThread', (target: ThreadTarget | ThreadItem) => comments.deleteThread(thread(target))),
    command('goodVibes.editComment', (comment: VsComment) => comments.startEdit(comment)),
    command('goodVibes.saveComment', (comment: VsComment) => comments.saveEdit(comment)),
    command('goodVibes.cancelEdit', (comment: VsComment) => comments.cancelEdit(comment)),
    command('goodVibes.sendToClaude', () => sendToClaude(model, pendingThreads(model), delivery())),
    command('goodVibes.sendToClaudeChoose', () => sendToClaude(model, pendingThreads(model), delivery(), { pickSession: true })),
    command('goodVibes.addCommentToChatChoose', (comment: VsComment) => sendIds([comment.threadId], { pickSession: true })),
    command('goodVibes.sendThread', (target: ThreadTarget | ThreadItem) => sendIds([comments.resolveTarget(thread(target))])),
    command('goodVibes.setupClaude', () => connectClaude(context, repo.git.root)),
  );

  await setContext('goodVibes.active', true);
  await setContext('goodVibes.fileLayout', changes.layout);
  // Keep the copies Claude Code runs in sync with this extension version.
  void installScripts(context).catch(showError);
  await model.reloadComments().catch(showError);
  await model.refresh();
  void offerToConnect(context, repo.git.root).catch(showError);
  return { model };
}

export function deactivate(): void {}

function setContext(key: string, value: unknown): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', key, value);
}

function showError(error: unknown): void {
  void vscode.window.showErrorMessage(`Good Vibes: ${error instanceof Error ? error.message : String(error)}`);
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
