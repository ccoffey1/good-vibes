import { describe, expect, it } from 'vitest';
import { buildFileTree, flattenTree } from '../src/core/fileTree';

describe('buildFileTree', () => {
  const paths = ['README.md', 'src/core/a.ts', 'src/core/b.ts', 'src/ext/c.ts', 'lib/deep/only/d.ts', 'z.txt'];
  const tree = buildFileTree(paths, (p) => p);

  it('puts folders first, compacts single-child chains, and sorts by name', () => {
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(['folder:lib/deep/only', 'folder:src', 'file:README.md', 'file:z.txt']);
    const src = tree[1];
    expect(src?.kind === 'folder' && src.children.map((n) => n.name)).toEqual(['core', 'ext']);
    expect(tree[0]?.kind === 'folder' && tree[0].path).toBe('lib/deep/only');
  });

  it('flattens in display order', () => {
    expect(flattenTree(tree)).toEqual(['lib/deep/only/d.ts', 'src/core/a.ts', 'src/core/b.ts', 'src/ext/c.ts', 'README.md', 'z.txt']);
  });
});
