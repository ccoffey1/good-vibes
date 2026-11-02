import { describe, expect, it } from 'vitest';
import { hookCommand, mcpAddArgs, mergeHookSettings, shellQuote } from '../src/core/claudeSetup';

describe('mergeHookSettings', () => {
  const command = hookCommand('node', '/Users/me/Library/Application Support/good-vibes/bin/hook.js');

  it('quotes paths with spaces', () => {
    expect(command).toBe(`node '/Users/me/Library/Application Support/good-vibes/bin/hook.js' --good-vibes-hook`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('adds both hooks while preserving unrelated settings and hooks', () => {
    const existing = {
      permissions: { allow: ['Bash(ls)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    };
    const merged = mergeHookSettings(existing, command);
    expect(merged.permissions).toEqual(existing.permissions);
    expect(merged.hooks?.Stop).toHaveLength(2);
    expect(merged.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(command);
    expect(existing.hooks.Stop).toHaveLength(1);
  });

  it('is idempotent and replaces stale entries', () => {
    const once = mergeHookSettings(undefined, hookCommand('node', '/old/hook.js'));
    const twice = mergeHookSettings(once, command);
    expect(twice.hooks?.Stop).toHaveLength(1);
    expect(twice.hooks?.Stop?.[0]?.hooks[0]?.command).toBe(command);
  });

  it('refuses non-object settings', () => {
    expect(() => mergeHookSettings([], command)).toThrow();
  });
});

describe('mcpAddArgs', () => {
  it('registers at local scope and passes the base branch through', () => {
    expect(mcpAddArgs('node', '/x/mcp.js', 'develop')).toEqual(['mcp', 'add', '--scope', 'local', 'good-vibes', '--', 'node', '/x/mcp.js', '--base', 'develop']);
  });
});
