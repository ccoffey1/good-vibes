/** Display-time tweaks to comment Markdown before VS Code renders it. */

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', dart: 'dart',
  sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  md: 'markdown', css: 'css', scss: 'scss', html: 'html', vue: 'vue', svelte: 'svelte', sql: 'sql',
};

/** Fence language for a repo path, or undefined when unknown. */
export function languageForFile(file: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
  return ext ? LANGUAGE_BY_EXTENSION[ext] : undefined;
}

/**
 * Gives untagged fenced code blocks the commented file's language so VS Code syntax-highlights them.
 * Only opening fences without an info string are touched; tagged blocks and closing fences are kept.
 */
export function tagCodeFences(markdown: string, language: string | undefined): string {
  if (!language) return markdown;
  let open: string | undefined; // the fence that opened the current block
  return markdown
    .split('\n')
    .map((line) => {
      const fence = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (!fence) return line;
      const [, indent = '', marks = '', info = ''] = fence;
      if (open) {
        if (marks[0] === open[0] && marks.length >= open.length && !info.trim()) open = undefined;
        return line;
      }
      open = marks;
      return info.trim() ? line : `${indent}${marks}${language}`;
    })
    .join('\n');
}
