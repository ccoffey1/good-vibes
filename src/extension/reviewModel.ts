import type { ReviewThread } from '../core/comments/model';
import { listChangedFiles, type ChangedFile } from '../core/diff';
import type { ReviewRepository } from '../core/repository';
import { resolveScope, scopeKey, type ResolvedScope, type ReviewScope } from '../core/scopes';
import { snapshotWorkingTree } from '../core/checkpoints';
import { Signal } from '../core/signal';
import { readTurns, type Turn } from '../core/turns';

/** Minimal key-value persistence (VS Code's Memento satisfies it). */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ReviewSnapshot {
  resolved: ResolvedScope;
  files: ChangedFile[];
  /**
   * Paths whose right-hand content is identical to the file on disk. Those diffs can show the real
   * file (editable and commentable) even when reviewing a past turn or commit.
   */
  onDisk: ReadonlySet<string>;
}

const SCOPE_KEY = 'goodVibes.scope';
const VIEWED_KEY = 'goodVibes.viewed';

/**
 * Holds the review state for one repository and recomputes it on demand. Free of the VS Code API
 * so the logic can be exercised with a plain repository in tests.
 */
export class ReviewModel {
  private readonly filesChanged = new Signal();
  private readonly commentsChanged = new Signal();
  private readonly turnEnded = new Signal<Turn>();
  private refreshing: Promise<void> | undefined;
  private refreshQueued = false;

  scope: ReviewScope;
  snapshot: ReviewSnapshot | undefined;
  turns: Turn[] = [];
  threads: ReviewThread[] = [];
  lastError: string | undefined;

  constructor(
    readonly repo: ReviewRepository,
    private readonly baseBranch: () => string | undefined,
    private readonly state: KeyValueStore,
  ) {
    this.scope = state.get<ReviewScope>(SCOPE_KEY) ?? { kind: 'branch' };
  }

  readonly onDidChangeFiles = this.filesChanged.subscribe;
  readonly onDidChangeComments = this.commentsChanged.subscribe;
  /** Fires when a turn that was running at the previous reload has since ended. */
  readonly onDidEndTurn = this.turnEnded.subscribe;

  async setScope(scope: ReviewScope): Promise<void> {
    this.scope = scope;
    await this.state.update(SCOPE_KEY, scope);
    await this.refresh();
  }

  /** Recomputes the file list. Concurrent calls coalesce into at most one follow-up run. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = undefined;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  async reloadTurns(): Promise<void> {
    const previous = new Map(this.turns.map((t) => [t.id, t]));
    this.turns = await readTurns(this.repo.layout.turnsFile);
    for (const turn of this.turns) {
      const before = previous.get(turn.id);
      if (turn.endRef && before && !before.endRef) this.turnEnded.fire(turn);
    }
  }

  async reloadComments(): Promise<void> {
    this.threads = (await this.repo.comments.read()).threads;
    this.commentsChanged.fire();
  }

  isViewed(file: ChangedFile): boolean {
    return this.viewedMap()[file.path] === file.newBlob;
  }

  async setViewed(file: ChangedFile, viewed: boolean): Promise<void> {
    const map = { ...this.viewedMap() };
    // Keyed by content: once the file changes again it drops back to "not viewed".
    if (viewed) map[file.path] = file.newBlob;
    else delete map[file.path];
    await this.state.update(VIEWED_KEY, map);
    this.filesChanged.fire();
  }

  get scopeKey(): string {
    return scopeKey(this.scope);
  }

  private viewedMap(): Record<string, string> {
    return this.state.get<Record<string, string>>(VIEWED_KEY) ?? {};
  }

  private async doRefresh(): Promise<void> {
    const { git } = this.repo;
    try {
      await this.reloadTurns();
      const scope = this.scope;
      // The turn log may have been cleared since this scope was saved.
      if (scope.kind === 'turn' && !this.turns.some((t) => t.id === scope.turnId)) this.scope = { kind: 'branch' };
      const resolved = await resolveScope(git, this.scope, { baseBranch: this.baseBranch(), turns: this.turns });
      const files = await listChangedFiles(git, resolved.left, resolved.right);
      let onDisk: Set<string>;
      if (resolved.rightIsWorkingTree) {
        onDisk = new Set(files.map((f) => f.path));
      } else {
        const current = await snapshotWorkingTree(git);
        const drifted = new Set((await listChangedFiles(git, resolved.right, current)).flatMap((f) => [f.path, f.oldPath ?? f.path]));
        onDisk = new Set(files.filter((f) => !drifted.has(f.path)).map((f) => f.path));
      }
      this.snapshot = { resolved, files, onDisk };
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.filesChanged.fire();
  }
}
