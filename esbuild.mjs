// Bundles the three entry points. The hook and MCP server run under plain Node
// (spawned by Claude Code), so everything they import must be bundled in.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const builds = [
  { ...shared, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...shared, entryPoints: ['src/mcp/main.ts'], outfile: 'dist/mcp.js' },
  { ...shared, entryPoints: ['src/hook/main.ts'], outfile: 'dist/hook.js' },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
