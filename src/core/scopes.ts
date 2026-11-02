import { snapshotWorkingTree } from './checkpoints';
import type { Git } from './git';
import { effectiveEndRef, type Turn } from './turns';

/** What a review compares. */
export type ReviewScope =
  | { kind: 'branch' }
  | { kind: 'uncommitted' }
  | { kind: 'commit'; sha: string }
  | { kind: 'turn'; turnId: string };

export interface ResolvedScope {
  scope: ReviewScope;
  /** Tree-ish for the "before" side. */
  left: string;
  /** Tree-ish for the "after" side. */
  right: string;
  /** True when `right` is a fresh snapshot of the files on disk, so they can be opened and edited directly. */
  rightIsWorkingTree: boolean;
  label: string;
}

export interface ScopeContext {
  /** Branch scope base; detected when omitted. */
  baseBranch?: string;
  turns: readonly Turn[];
}

export function scopeKey(scope: ReviewScope): string {
  switch (scope.kind) {
    case 'branch':
    case 'uncommitted':
      return scope.kind;
    case 'commit':
      return `commit:${scope.sha}`;
    case 'turn':
      return `turn:${scope.turnId}`;
  }
}

/** Picks the comparison base: explicit setting, else origin's default branch, else main/master. */
export async function detectBaseBranch(git: Git, configured?: string): Promise<string | undefined> {
  if (configured) return configured;
  const originHead = await git.tryExec(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  const candidates = [originHead?.trim(), 'origin/main', 'origin/master', 'main', 'master'];
  for (const candidate of candidates) {
    if (candidate && (await git.revParse(candidate))) return candidate;
  }
  return undefined;
}

export async function resolveScope(git: Git, scope: ReviewScope, context: ScopeContext): Promise<ResolvedScope> {
  switch (scope.kind) {
    case 'branch': {
      const base = await detectBaseBranch(git, context.baseBranch);
      const head = await git.revParse('HEAD');
      const mergeBase = base && head ? (await git.tryExec(['merge-base', base, 'HEAD']))?.trim() : undefined;
      return {
        scope,
        left: mergeBase || head || (await git.emptyTree()),
        right: await snapshotWorkingTree(git),
        rightIsWorkingTree: true,
        label: base ? `Branch vs ${base}` : 'Branch (no base found)',
      };
    }
    case 'uncommitted':
      return {
        scope,
        left: (await git.revParse('HEAD')) ?? (await git.emptyTree()),
        right: await snapshotWorkingTree(git),
        rightIsWorkingTree: true,
        label: 'Uncommitted changes',
      };
    case 'commit': {
      const parent = (await git.revParse(`${scope.sha}^`)) ?? (await git.emptyTree());
      const subject = (await git.exec(['log', '-1', '--format=%s', scope.sha])).trim();
      return { scope, left: parent, right: scope.sha, rightIsWorkingTree: false, label: `${scope.sha.slice(0, 7)} ${subject}` };
    }
    case 'turn': {
      const index = context.turns.findIndex((t) => t.id === scope.turnId);
      const turn = context.turns[index];
      if (!turn) throw new Error(`Turn ${scope.turnId} no longer exists`);
      const end = effectiveEndRef(context.turns, turn);
      return {
        scope,
        left: turn.startRef,
        right: end ?? (await snapshotWorkingTree(git)),
        rightIsWorkingTree: end === undefined,
        label: `Turn ${index + 1}: ${summarizePrompt(turn.prompt)}`,
      };
    }
  }
}

export function summarizePrompt(prompt: string, max = 60): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line || '(empty prompt)';
}
