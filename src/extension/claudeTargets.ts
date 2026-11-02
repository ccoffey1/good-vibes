import * as vscode from 'vscode';
import { listRunningSessions, readSessionInfo, readSessionTitle } from '../core/claudeSessions';
import { findClaudeDescendants, readProcessTable } from '../core/processes';
import { summarizePrompt } from '../core/scopes';
import type { Turn } from '../core/turns';

type TerminalTarget = { kind: 'terminal'; terminal: vscode.Terminal; claudePid: number; lastPrompt?: string; title?: string; status?: string };
type ExtensionChatTarget = { kind: 'extensionChat'; sessionId: string; claudePid: number; title?: string; status?: string };
type SessionTarget = TerminalTarget | ExtensionChatTarget;

/** Where a review can be handed to Claude. */
export type ClaudeTarget =
  | SessionTarget
  /** Whatever chat is open in the Claude Code extension; used only when no specific session is found. */
  | { kind: 'panel' }
  | { kind: 'clipboard' };

export type Delivery = 'auto' | 'ask' | 'terminal' | 'claudePanel' | 'clipboard';

/** Claude Code extension commands. `insertAtMention` mentions the active editor in every visible chat. */
const PANEL_MENTION = 'claude-vscode.insertAtMention';
/** Opens or reveals a specific chat by session id. */
const OPEN_CHAT = 'claude-vscode.editor.open';

/** The session picked from the dropdown; later sends reuse it while it is still running. */
let selected: { kind: 'session'; claudePid: number } | { kind: 'panel' | 'clipboard' } | undefined;
let lastUsedPid: number | undefined;

/**
 * Running Claude sessions for this repo: CLIs in VS Code's integrated terminals (found through each
 * terminal's process tree) and chats in the Claude Code extension (from Claude's session files).
 */
export async function findSessions(root: string, turns: readonly Turn[]): Promise<SessionTarget[]> {
  const table = await readProcessTable();
  const sessions: SessionTarget[] = [];

  for (const terminal of vscode.window.terminals) {
    const shellPid = await terminal.processId;
    if (!shellPid) continue;
    for (const claude of findClaudeDescendants(table, shellPid)) {
      const info = await readSessionInfo(claude.pid);
      const lastPrompt = turns.filter((t) => t.claudePid === claude.pid).at(-1)?.prompt;
      sessions.push({ kind: 'terminal', terminal, claudePid: claude.pid, lastPrompt, title: info.title, status: info.status });
    }
  }

  const alive = new Set(table.map((p) => p.pid));
  for (const session of await listRunningSessions(root, alive)) {
    if (session.entrypoint !== 'claude-vscode') continue;
    sessions.push({ kind: 'extensionChat', sessionId: session.sessionId, claudePid: session.pid, title: await readSessionTitle(session), status: session.status });
  }

  return sessions.sort((a, b) => Number(b.claudePid === lastUsedPid) - Number(a.claudePid === lastUsedPid));
}

/**
 * Picks the target for a send. `auto` uses the remembered session if it's still running, the only
 * session if there is one, and asks when there are several. With none it falls back to the Claude
 * extension's open chat, or the clipboard. Returns undefined if the user dismissed the picker.
 */
export async function chooseTarget(delivery: Delivery, root: string, turns: readonly Turn[], forcePick = false): Promise<ClaudeTarget | undefined> {
  const panel = (await vscode.commands.getCommands(true)).includes(PANEL_MENTION);
  const fallback: ClaudeTarget = panel ? { kind: 'panel' } : { kind: 'clipboard' };
  if (!forcePick && delivery === 'clipboard') return { kind: 'clipboard' };
  if (!forcePick && delivery === 'claudePanel') return fallback;

  const all = await findSessions(root, turns);
  const sessions = delivery === 'terminal' && !forcePick ? all.filter((s) => s.kind === 'terminal') : all;
  if (forcePick || delivery === 'ask') return remember(await pick(sessions));

  const remembered = resolveSelected(sessions, panel);
  if (remembered) return remembered;
  if (sessions.length === 1) return sessions[0];
  if (sessions.length > 1) return remember(await pick(sessions));
  if (delivery === 'terminal') {
    void vscode.window.showWarningMessage('No Claude Code session found in VS Code terminals.');
    return undefined;
  }
  return fallback;
}

/**
 * Puts an @-mention of `file` into the chosen target's input. The user presses Enter in Claude to send.
 * Returns a short description of where it went.
 */
export async function deliverMention(target: ClaudeTarget, mention: string, file: vscode.Uri): Promise<string> {
  switch (target.kind) {
    case 'terminal':
      lastUsedPid = target.claudePid;
      // No newline (the user submits) and no terminal.show() (don't pull the panel into view).
      target.terminal.sendText(`${mention} `, false);
      return `"${target.title ?? target.terminal.name}"`;
    case 'extensionChat':
      lastUsedPid = target.claudePid;
      // Bring that chat forward first: the mention goes to the chats that are visible.
      await vscode.commands.executeCommand(OPEN_CHAT, target.sessionId);
      await withFileActive(file, () => vscode.commands.executeCommand(PANEL_MENTION));
      return `"${target.title ?? 'Claude chat'}"`;
    case 'panel':
      await withFileActive(file, () => vscode.commands.executeCommand(PANEL_MENTION));
      return 'the Claude Code chat';
    case 'clipboard':
      await vscode.env.clipboard.writeText(`${mention} `);
      return 'the clipboard';
  }
}

function remember(target: ClaudeTarget | undefined): ClaudeTarget | undefined {
  if (target) selected = target.kind === 'terminal' || target.kind === 'extensionChat' ? { kind: 'session', claudePid: target.claudePid } : { kind: target.kind };
  return target;
}

function resolveSelected(sessions: readonly SessionTarget[], panel: boolean): ClaudeTarget | undefined {
  switch (selected?.kind) {
    case 'session': {
      const pid = selected.claudePid;
      return sessions.find((s) => s.claudePid === pid);
    }
    case 'panel':
      return panel ? { kind: 'panel' } : undefined;
    case 'clipboard':
      return { kind: 'clipboard' };
    default:
      return undefined;
  }
}

/**
 * The Claude extension's mention command references the active editor, so the file is opened in its
 * own (non-preview, so a preview diff isn't replaced) tab just long enough to run the command, then
 * closed, which returns focus to whatever was active before.
 */
async function withFileActive(file: vscode.Uri, run: () => Thenable<unknown>): Promise<void> {
  const editor = await vscode.window.showTextDocument(file, { preview: false, preserveFocus: false });
  editor.selection = new vscode.Selection(0, 0, 0, 0); // empty selection = mention the whole file
  try {
    await run();
  } finally {
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === file.toString());
    if (tab) await vscode.window.tabGroups.close(tab, true);
  }
}

interface TargetPick extends vscode.QuickPickItem {
  target: ClaudeTarget;
}

async function pick(sessions: readonly SessionTarget[]): Promise<ClaudeTarget | undefined> {
  const items: TargetPick[] = sessions.map((session) => ({
    // Icon tells terminal from extension chat; the label is Claude's chat title when it has one.
    label:
      session.kind === 'terminal'
        ? `$(terminal) ${session.title ?? session.terminal.name}`
        : `$(comment-discussion) ${session.title ?? 'New chat'}`,
    description: [session.status ?? '', session.claudePid === lastUsedPid ? 'last used' : ''].filter(Boolean).join(' · '),
    detail: session.kind === 'terminal' && session.lastPrompt ? `Last prompt: ${summarizePrompt(session.lastPrompt, 90)}` : undefined,
    target: session,
  }));
  items.push({ label: '$(clippy) Copy to clipboard', target: { kind: 'clipboard' } });
  const choice = await vscode.window.showQuickPick(items, { title: 'Send review to which Claude session?', matchOnDetail: true });
  return choice?.target;
}
