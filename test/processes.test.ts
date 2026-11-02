import { describe, expect, it } from 'vitest';
import { findClaudeAncestor, findClaudeDescendants, isClaudeSession, parseProcessTable } from '../src/core/processes';

const TABLE = parseProcessTable(`
    1     0 /sbin/launchd
  100     1 /Applications/Visual Studio Code.app/Contents/MacOS/Code
  200   100 /bin/zsh -il
  201   200 claude
  202   201 /bin/sh -c node '/x/hook.js' --good-vibes-hook
  203   202 node /x/hook.js --good-vibes-hook
  300   100 /bin/zsh -il
  301   300 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --model opus
  400   100 /bin/zsh -il
  401   400 /Users/me/.local/bin/claude mcp list
  500     1 /Users/me/.local/bin/claude --chrome-native-host
`);

describe('Claude process detection', () => {
  it('recognises native and npm CLI sessions but not helpers or subcommands', () => {
    expect(isClaudeSession('claude')).toBe(true);
    expect(isClaudeSession('/Users/me/.local/share/claude/versions/2.1.314')).toBe(true);
    expect(isClaudeSession('/Users/me/.local/bin/claude --resume')).toBe(true);
    expect(isClaudeSession('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(true);
    expect(isClaudeSession('/Users/me/.local/bin/claude --chrome-native-host')).toBe(false);
    expect(isClaudeSession('claude mcp add x')).toBe(false);
    expect(isClaudeSession('claude -p hi')).toBe(false);
    expect(isClaudeSession('/bin/zsh -c claude-ish')).toBe(false);
  });

  it('finds sessions under each terminal shell', () => {
    expect(findClaudeDescendants(TABLE, 200).map((p) => p.pid)).toEqual([201]);
    expect(findClaudeDescendants(TABLE, 300).map((p) => p.pid)).toEqual([301]);
    expect(findClaudeDescendants(TABLE, 400)).toEqual([]);
  });

  it('finds the session that spawned a hook process', () => {
    expect(findClaudeAncestor(TABLE, 203)?.pid).toBe(201);
    expect(findClaudeAncestor(TABLE, 400)).toBeUndefined();
  });
});
