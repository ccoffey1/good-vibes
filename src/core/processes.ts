import { execFile } from 'node:child_process';

/** Finding Claude Code CLI processes, so comments can be sent to a specific running session. */

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

/** Parses `ps -A -o pid=,ppid=,command=`. */
export function parseProcessTable(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' });
  }
  return processes;
}

/** Matches the interactive CLI (native or npm install), not helpers like the Chrome host or `claude mcp …`. */
export function isClaudeSession(command: string): boolean {
  const [executable = '', ...args] = command.trim().split(/\s+/);
  // The native installer launches either `claude` or a versioned binary under …/claude/versions/<v>.
  const isNative = /(^|\/)claude$/.test(executable) || /\/claude\/versions\/[^/]+$/.test(executable);
  const isNpm = /(^|\/)node$/.test(executable) && /@anthropic-ai\/claude-code\/cli\.(m?js)$/.test(args[0] ?? '');
  if (!isNative && !isNpm) return false;
  const rest = isNpm ? args.slice(1) : args;
  const subcommand = rest.find((arg) => !arg.startsWith('-'));
  const helperFlags = ['--chrome-native-host', '--print', '-p'];
  return !rest.some((arg) => helperFlags.includes(arg)) && !['mcp', 'config', 'doctor', 'update', 'install'].includes(subcommand ?? '');
}

/** Claude sessions running anywhere below `rootPid` (e.g. a terminal's shell). Outermost match per branch. */
export function findClaudeDescendants(table: readonly ProcessInfo[], rootPid: number): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const proc of table) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc]);
  const found: ProcessInfo[] = [];
  const visit = (pid: number, depth: number) => {
    if (depth > 8) return;
    for (const child of children.get(pid) ?? []) {
      if (isClaudeSession(child.command)) found.push(child);
      else visit(child.pid, depth + 1);
    }
  };
  visit(rootPid, 0);
  return found;
}

/** Nearest ancestor of `pid` that is a Claude session (the hook runs a few shells below it). */
export function findClaudeAncestor(table: readonly ProcessInfo[], pid: number): ProcessInfo | undefined {
  const byPid = new Map(table.map((proc) => [proc.pid, proc]));
  let current = byPid.get(pid);
  for (let depth = 0; current && depth < 8; depth++) {
    if (isClaudeSession(current.command)) return current;
    current = byPid.get(current.ppid);
  }
  return undefined;
}

export function readProcessTable(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024, timeout: 5000 }, (error, stdout) => {
      resolve(error ? [] : parseProcessTable(stdout));
    });
  });
}
