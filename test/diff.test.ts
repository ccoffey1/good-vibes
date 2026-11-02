import { describe, expect, it } from 'vitest';
import { parseNumstat, parseRaw } from '../src/core/diff';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

describe('parseRaw', () => {
  it('parses modifications, additions, and renames', () => {
    const out = [`:100644 100644 ${A} ${B} M`, 'src/a.ts', `:000000 100644 ${Z} ${B} A`, 'new file.ts', `:100644 100644 ${A} ${B} R087`, 'old.ts', 'new.ts', ''].join('\0');
    expect(parseRaw(out)).toEqual([
      { path: 'src/a.ts', status: 'modified', oldBlob: A, newBlob: B },
      { path: 'new file.ts', status: 'added', oldBlob: Z, newBlob: B },
      { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', oldBlob: A, newBlob: B },
    ]);
  });

  it('rejects unexpected output', () => {
    expect(() => parseRaw('garbage\0')).toThrow(/unexpected raw diff header/);
  });
});

describe('parseNumstat', () => {
  it('parses counts, binary files, and renames', () => {
    const out = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '2\t0\t', 'old.ts', 'new.ts', ''].join('\0');
    const counts = parseNumstat(out);
    expect(counts.get('src/a.ts')).toEqual({ additions: 3, deletions: 1 });
    expect(counts.get('img.png')).toEqual({ additions: null, deletions: null });
    expect(counts.get('new.ts')).toEqual({ additions: 2, deletions: 0 });
  });
});
