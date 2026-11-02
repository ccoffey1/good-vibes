import { spawn } from 'node:child_process';

export interface GitRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs `git <args>`. Injected so tests and alternative transports can replace it. */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitRunResult>;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export const spawnGit: GitRunner = (args, { cwd, env, input }) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? 1,
      }),
    );
    child.stdin.end(input ?? '');
  });

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** A git repository rooted at a working-tree top level. */
export class Git {
  constructor(
    readonly root: string,
    private readonly runner: GitRunner = spawnGit,
  ) {}

  /** Finds the working-tree root containing `cwd`, or undefined outside a repository. */
  static async discover(cwd: string, runner: GitRunner = spawnGit): Promise<Git | undefined> {
    const result = await runner(['rev-parse', '--show-toplevel'], { cwd }).catch(() => undefined);
    if (!result || result.code !== 0) return undefined;
    return new Git(result.stdout.trim(), runner);
  }

  /** Runs git and returns stdout; throws GitError on a non-zero exit. */
  async exec(args: readonly string[], options: ExecOptions = {}): Promise<string> {
    const result = await this.runner(args, { cwd: this.root, ...options });
    if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
    return result.stdout;
  }

  /** Runs git and returns stdout, or undefined on a non-zero exit (for probes like `rev-parse --verify`). */
  async tryExec(args: readonly string[], options: ExecOptions = {}): Promise<string | undefined> {
    const result = await this.runner(args, { cwd: this.root, ...options });
    return result.code === 0 ? result.stdout : undefined;
  }

  async revParse(rev: string): Promise<string | undefined> {
    const out = await this.tryExec(['rev-parse', '-q', '--verify', `${rev}^{object}`]);
    return out?.trim() || undefined;
  }

  /** Absolute path of a file inside the git dir (worktree-aware, e.g. `index`, `info/exclude`). */
  async gitPath(name: string): Promise<string> {
    const out = await this.exec(['rev-parse', '--path-format=absolute', '--git-path', name]);
    return out.trim();
  }

  /** The empty tree's id, which differs between SHA-1 and SHA-256 repositories. */
  async emptyTree(): Promise<string> {
    return (await this.exec(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim();
  }
}

/** Splits NUL-separated git output, dropping the trailing empty field. */
export function splitNul(output: string): string[] {
  const parts = output.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}
