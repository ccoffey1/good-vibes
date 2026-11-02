import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangedFile, FileStatus } from '../core/diff';
import { buildFileTree, flattenTree, type FolderNode, type TreeNode } from '../core/fileTree';
import type { KeyValueStore, ReviewModel } from './reviewModel';

export type FileLayout = 'list' | 'tree';
const LAYOUT_KEY = 'goodVibes.fileLayout';

const STATUS_LETTER: Record<FileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
};

export class FileItem extends vscode.TreeItem {
  constructor(
    readonly file: ChangedFile,
    root: string,
    viewed: boolean,
    commentCount: number,
    /** In tree layout the folder is already shown by the parent node. */
    showDir: boolean,
  ) {
    super(path.posix.basename(file.path), vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(file.path);
    const counts = file.additions === null ? 'binary' : `+${file.additions} −${file.deletions}`;
    const comments = commentCount > 0 ? ` · ${commentCount} comment${commentCount === 1 ? '' : 's'}` : '';
    this.id = file.path;
    this.description = `${STATUS_LETTER[file.status]} ${showDir && dir !== '.' ? `${dir} · ` : ''}${counts}${comments}`;
    this.resourceUri = vscode.Uri.file(path.join(root, file.path));
    this.tooltip = `${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}\n${file.status}, ${counts}${viewed ? '\nViewed' : ''}`;
    this.checkboxState = viewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    this.contextValue = 'file';
    this.command = { command: 'goodVibes.openFile', title: 'Open Diff', arguments: [file.path] };
  }
}

export class FolderItem extends vscode.TreeItem {
  constructor(
    readonly node: FolderNode<ChangedFile>,
    root: string,
    viewedCount: number,
    fileCount: number,
  ) {
    super(node.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `dir:${node.path}`;
    this.resourceUri = vscode.Uri.file(path.join(root, node.path));
    this.iconPath = vscode.ThemeIcon.Folder;
    this.description = `${viewedCount}/${fileCount} viewed`;
    this.contextValue = 'folder';
  }
}

type ChangesNode = FileItem | FolderItem;

/** Changed files with a "viewed" checkbox each, shown as a flat list or a directory tree. */
export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangesNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly model: ReviewModel,
    private readonly state: KeyValueStore,
  ) {}

  get layout(): FileLayout {
    return this.state.get<FileLayout>(LAYOUT_KEY) ?? 'list';
  }

  async setLayout(layout: FileLayout): Promise<void> {
    await this.state.update(LAYOUT_KEY, layout);
    this.changed.fire();
  }

  fire(): void {
    this.changed.fire();
  }

  getTreeItem(item: ChangesNode): ChangesNode {
    return item;
  }

  getChildren(parent?: ChangesNode): ChangesNode[] {
    if (parent instanceof FileItem) return [];
    if (parent instanceof FolderItem) return parent.node.children.map((node) => this.toItem(node));
    const files = this.model.snapshot?.files ?? [];
    if (this.layout === 'list') return files.map((file) => this.fileItem(file, true));
    return buildFileTree(files, (f) => f.path).map((node) => this.toItem(node));
  }

  /** Files in the order the view shows them, so next/previous follows what's on screen. */
  orderedFiles(): ChangedFile[] {
    const files = this.model.snapshot?.files ?? [];
    return this.layout === 'list' ? files : flattenTree(buildFileTree(files, (f) => f.path));
  }

  dispose(): void {
    this.changed.dispose();
  }

  private toItem(node: TreeNode<ChangedFile>): ChangesNode {
    if (node.kind === 'file') return this.fileItem(node.item, false);
    const files = flattenTree(node.children);
    return new FolderItem(node, this.model.repo.git.root, files.filter((f) => this.model.isViewed(f)).length, files.length);
  }

  private fileItem(file: ChangedFile, showDir: boolean): FileItem {
    const comments = this.model.threads.filter((t) => t.status === 'open' && t.file === file.path).length;
    return new FileItem(file, this.model.repo.git.root, this.model.isViewed(file), comments, showDir);
  }
}
