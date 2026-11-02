/**
 * Pure helpers for wiring Claude Code to Good Vibes: hook entries in `.claude/settings.local.json`
 * and the `claude mcp add` invocation. Kept free of I/O so the merge rules are testable.
 */

/** Trailing argument that marks hook commands we own, so re-running setup replaces rather than duplicates. */
export const HOOK_MARKER = '--good-vibes-hook';
export const HOOK_EVENTS = ['UserPromptSubmit', 'Stop'] as const;
export const MCP_SERVER_NAME = 'good-vibes';

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, HookMatcher[]> };

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(nodePath: string, hookScript: string): string {
  return `${shellQuote(nodePath)} ${shellQuote(hookScript)} ${HOOK_MARKER}`;
}

/** Returns new settings with our hooks installed exactly once, preserving everything else. */
export function mergeHookSettings(existing: unknown, command: string): Settings {
  if (existing !== undefined && (typeof existing !== 'object' || existing === null || Array.isArray(existing))) {
    throw new Error('Claude settings file must contain a JSON object');
  }
  const settings: Settings = structuredClone((existing as Settings | undefined) ?? {});
  const hooks: Record<string, HookMatcher[]> = settings.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? [])
      .map((matcher) => ({ ...matcher, hooks: (matcher.hooks ?? []).filter((h) => !h.command?.includes(HOOK_MARKER)) }))
      .filter((matcher) => matcher.hooks.length > 0);
    hooks[event] = [...kept, { hooks: [{ type: 'command', command, timeout: 30 }] }];
  }
  settings.hooks = hooks;
  return settings;
}

export function mcpAddArgs(nodePath: string, mcpScript: string, baseBranch?: string): string[] {
  const args = ['mcp', 'add', '--scope', 'local', MCP_SERVER_NAME, '--', nodePath, mcpScript];
  if (baseBranch) args.push('--base', baseBranch);
  return args;
}
