import { splitNul, type Git } from './git';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';

export interface ChangedFile {
  /** Repo-relative POSIX path on the right side (the left side for deletions). */
  path: string;
  /** Left-side path when renamed or copied. */
  oldPath?: string;
  status: FileStatus;
  /** Blob ids; the all-zero id means "absent on that side". */
  oldBlob: string;
  newBlob: string;
  /** Null for binary files. */
  additions: number | null;
  deletions: number | null;
}

const STATUS_CODES: Record<string, FileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
};

interface RawEntry {
  path: string;
  oldPath?: string;
  status: FileStatus;
  oldBlob: string;
  newBlob: string;
}

/** Parses `git diff --raw -z --no-abbrev`. */
export function parseRaw(output: string): RawEntry[] {
  const fields = splitNul(output);
  const entries: RawEntry[] = [];
  for (let i = 0; i < fields.length; ) {
    const header = fields[i++] ?? '';
    const match = /^:\d+ \d+ (\w+) (\w+) ([A-Z])\d*$/.exec(header);
    if (!match) throw new Error(`unexpected raw diff header: ${header}`);
    const [, oldBlob = '', newBlob = '', code = ''] = match;
    const status = STATUS_CODES[code];
    if (!status) throw new Error(`unknown diff status: ${code}`);
    if (status === 'renamed' || status === 'copied') {
      const oldPath = fields[i++] ?? '';
      const path = fields[i++] ?? '';
      entries.push({ path, oldPath, status, oldBlob, newBlob });
    } else {
      entries.push({ path: fields[i++] ?? '', status, oldBlob, newBlob });
    }
  }
  return entries;
}

export interface LineCounts {
  additions: number | null;
  deletions: number | null;
}

/** Parses `git diff --numstat -z`, keyed by right-side path. */
export function parseNumstat(output: string): Map<string, LineCounts> {
  const fields = splitNul(output);
  const counts = new Map<string, LineCounts>();
  for (let i = 0; i < fields.length; ) {
    const field = fields[i++] ?? '';
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(field);
    if (!match) throw new Error(`unexpected numstat field: ${field}`);
    const [, added = '-', deleted = '-', inlinePath = ''] = match;
    // Renames put an empty path here, followed by the old and new paths as separate fields.
    let path = inlinePath;
    if (path === '') {
      i++; // old path
      path = fields[i++] ?? '';
    }
    counts.set(path, {
      additions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted),
    });
  }
  return counts;
}

/** Files that differ between two tree-ish objects, with blob ids and line counts. */
export async function listChangedFiles(git: Git, left: string, right: string): Promise<ChangedFile[]> {
  const diff = (...format: string[]) => git.exec(['diff', ...format, '-z', '-M', '--no-ext-diff', '--no-color', left, right]);
  const [raw, numstat] = await Promise.all([diff('--raw', '--no-abbrev'), diff('--numstat')]);
  const counts = parseNumstat(numstat);
  return parseRaw(raw)
    .map((entry) => ({ ...entry, ...(counts.get(entry.path) ?? { additions: null, deletions: null }) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface UnifiedDiffOptions {
  paths?: readonly string[];
  stat?: boolean;
}

/** Unified diff (or `--stat` summary) between two tree-ish objects. */
export async function unifiedDiff(git: Git, left: string, right: string, options: UnifiedDiffOptions = {}): Promise<string> {
  const args = ['diff', '-M', '--no-ext-diff', '--no-color'];
  if (options.stat) args.push('--stat=200');
  args.push(left, right);
  if (options.paths?.length) args.push('--', ...options.paths);
  return git.exec(args);
}

export function isAbsentBlob(blob: string): boolean {
  return /^0+$/.test(blob);
}
