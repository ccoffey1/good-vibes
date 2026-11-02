import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Git } from '../core/git';
import { isAbsentBlob, type ChangedFile } from '../core/diff';
import type { ReviewSnapshot } from './reviewModel';

/** Read-only documents for file contents at a git object (left side of diffs, past snapshots). */
export const GIT_SCHEME = 'good-vibes-git';

interface GitUriQuery {
  /** Blob id; empty means the file doesn't exist on that side. */
  blob: string;
}

export function gitUri(repoPath: string, blob: string): vscode.Uri {
  const query: GitUriQuery = { blob: isAbsentBlob(blob) ? '' : blob };
  // The real path keeps language detection and file icons working.
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${repoPath}`, query: JSON.stringify(query) });
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: Git) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { blob } = JSON.parse(uri.query) as GitUriQuery;
    if (!blob) return '';
    return this.git.exec(['cat-file', 'blob', blob]);
  }
}

export interface DiffUris {
  left: vscode.Uri;
  right: vscode.Uri;
  title: string;
}

/** Left/right documents for a changed file; the right side is the real file whenever possible. */
export function diffUris(root: string, snapshot: ReviewSnapshot, file: ChangedFile): DiffUris {
  const left = gitUri(file.oldPath ?? file.path, file.oldBlob);
  const right =
    file.status !== 'deleted' && snapshot.onDisk.has(file.path)
      ? vscode.Uri.file(path.join(root, file.path))
      : gitUri(file.path, file.newBlob);
  const name = path.posix.basename(file.path);
  const suffix = file.status === 'added' ? ' (added)' : file.status === 'deleted' ? ' (deleted)' : file.oldPath ? ` (from ${file.oldPath})` : '';
  return { left, right, title: `${name}${suffix} · ${snapshot.resolved.label}` };
}
