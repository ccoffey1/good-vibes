import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { HOOK_MARKER, hookCommand, mcpAddArgs, mergeHookSettings, MCP_SERVER_NAME, shellQuote } from '../core/claudeSetup';

export interface InstalledScripts {
  hook: string;
  mcp: string;
}

/**
 * Copies the bundled hook and MCP server to global storage. Claude Code settings point at these
 * copies, whose path stays the same across extension updates (the extension folder doesn't).
 */
export async function installScripts(context: vscode.ExtensionContext): Promise<InstalledScripts> {
  const binDir = path.join(context.globalStorageUri.fsPath, 'bin');
  await mkdir(binDir, { recursive: true });
  const scripts = { hook: path.join(binDir, 'hook.js'), mcp: path.join(binDir, 'mcp.js') };
  await copyFile(context.asAbsolutePath('dist/hook.js'), scripts.hook);
  await copyFile(context.asAbsolutePath('dist/mcp.js'), scripts.mcp);
  return scripts;
}

/** Adds the turn hooks to `.claude/settings.local.json` and registers the MCP server for this project. */
export async function connectClaude(context: vscode.ExtensionContext, root: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('goodVibes');
  const nodePath = config.get<string>('nodePath') || 'node';
  const scripts = await installScripts(context);

  const settingsFile = path.join(root, '.claude', 'settings.local.json');
  const existing = await readJson(settingsFile);
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify(mergeHookSettings(existing, hookCommand(nodePath, scripts.hook)), null, 2)}\n`);

  const addArgs = mcpAddArgs(nodePath, scripts.mcp, config.get<string>('baseBranch') || undefined);
  const mcpResult = await registerMcp(root, addArgs);

  const summary = 'Turn checkpoints are on (new Claude sessions pick up the hooks).';
  if (mcpResult.ok) {
    void vscode.window.showInformationMessage(`${summary} Registered the "${MCP_SERVER_NAME}" MCP server for this project.`);
    return;
  }
  const manual = `claude ${addArgs.map(shellQuote).join(' ')}`;
  const choice = await vscode.window.showWarningMessage(
    `${summary} Couldn't register the MCP server automatically (${mcpResult.error}). Run this in the project directory:`,
    { modal: true, detail: manual },
    'Copy Command',
  );
  if (choice === 'Copy Command') await vscode.env.clipboard.writeText(manual);
}

const CONNECT_PROMPT_DISMISSED = 'goodVibes.connectPromptDismissed';

/** True when this repo's Claude settings already carry the Good Vibes hooks. */
export async function isClaudeConnected(root: string): Promise<boolean> {
  const settings = await readFile(path.join(root, '.claude', 'settings.local.json'), 'utf8').catch(() => '');
  return settings.includes(HOOK_MARKER);
}

/** Offers (once per workspace, until dismissed) to connect Claude Code when this repo isn't set up. */
export async function offerToConnect(context: vscode.ExtensionContext, root: string): Promise<void> {
  if (context.workspaceState.get<boolean>(CONNECT_PROMPT_DISMISSED) || (await isClaudeConnected(root))) return;
  const choice = await vscode.window.showInformationMessage(
    'Connect Claude Code to Good Vibes in this repo? Claude gets per-turn diffs and can read, leave, and reply to review comments.',
    'Connect',
    "Don't Ask Again",
  );
  if (choice === 'Connect') await connectClaude(context, root);
  else if (choice === "Don't Ask Again") await context.workspaceState.update(CONNECT_PROMPT_DISMISSED, true);
}

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} isn't valid JSON; fix it and run setup again`);
  }
}

type McpResult = { ok: true } | { ok: false; error: string };

/**
 * Runs `claude mcp remove` then `claude mcp add` through a login shell, since VS Code launched from
 * the Dock doesn't inherit the PATH where the `claude` CLI usually lives.
 */
async function registerMcp(root: string, addArgs: readonly string[]): Promise<McpResult> {
  const shell = process.env.SHELL || '/bin/zsh';
  const remove = `claude mcp remove --scope local ${MCP_SERVER_NAME} >/dev/null 2>&1`;
  const add = `claude ${addArgs.map(shellQuote).join(' ')}`;
  return new Promise((resolve) => {
    execFile(shell, ['-lc', `${remove}; ${add}`], { cwd: root, timeout: 30_000 }, (error, _stdout, stderr) => {
      resolve(error ? { ok: false, error: (stderr || error.message).trim().split('\n').at(-1) ?? 'unknown error' } : { ok: true });
    });
  });
}
