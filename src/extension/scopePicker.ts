import * as vscode from 'vscode';
import { detectBaseBranch, scopeKey, summarizePrompt, type ReviewScope } from '../core/scopes';
import type { ReviewModel } from './reviewModel';

interface ScopePick extends vscode.QuickPickItem {
  scope?: ReviewScope;
}

const MAX_TURNS = 30;
const MAX_COMMITS = 30;

/** Quick pick of everything reviewable: branch, uncommitted, Claude turns (newest first), branch commits. */
export async function pickScope(model: ReviewModel, configuredBase: string | undefined): Promise<ReviewScope | undefined> {
  const { git } = model.repo;
  await model.reloadTurns();
  const base = await detectBaseBranch(git, configuredBase);
  const current = model.scopeKey;
  const mark = (scope: ReviewScope, item: ScopePick): ScopePick => ({
    ...item,
    scope,
    description: [item.description, scopeKey(scope) === current ? '(current)' : ''].filter(Boolean).join(' '),
  });

  const items: ScopePick[] = [
    mark({ kind: 'branch' }, { label: '$(git-branch) All branch changes', description: base ? `vs ${base}, including uncommitted` : 'no base branch found' }),
    mark({ kind: 'uncommitted' }, { label: '$(edit) Uncommitted changes', description: 'vs HEAD' }),
  ];

  const turns = model.turns.slice(-MAX_TURNS).reverse();
  if (turns.length > 0) {
    items.push({ label: 'Claude turns', kind: vscode.QuickPickItemKind.Separator });
    for (const turn of turns) {
      const number = model.turns.indexOf(turn) + 1;
      items.push(
        mark(
          { kind: 'turn', turnId: turn.id },
          {
            label: `$(sparkle) Turn ${number}: ${summarizePrompt(turn.prompt)}`,
            description: `${relativeTime(turn.startedAt)}${turn.endRef ? '' : ' · in progress or interrupted'}`,
          },
        ),
      );
    }
  }

  const commits = base ? await branchCommits(model, base) : [];
  if (commits.length > 0) {
    items.push({ label: 'Commits on this branch', kind: vscode.QuickPickItemKind.Separator });
    for (const commit of commits) {
      items.push(mark({ kind: 'commit', sha: commit.sha }, { label: `$(git-commit) ${commit.subject}`, description: `${commit.sha.slice(0, 7)} · ${commit.when}` }));
    }
  }

  const choice = await vscode.window.showQuickPick(items, { title: 'Review scope', placeHolder: 'What do you want to review?', matchOnDescription: true });
  return choice?.scope;
}

async function branchCommits(model: ReviewModel, base: string): Promise<Array<{ sha: string; subject: string; when: string }>> {
  const out = await model.repo.git.tryExec(['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x00%s%x00%cr', `${base}..HEAD`]);
  return (out ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', subject = '', when = ''] = line.split('\0');
      return { sha, subject, when };
    });
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}
