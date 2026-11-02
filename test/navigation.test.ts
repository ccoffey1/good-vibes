import { describe, expect, it } from 'vitest';
import { nextUnviewed, stepIndex, stepPosition } from '../src/core/navigation';

describe('navigation', () => {
  it('steps with wrap-around', () => {
    expect(stepIndex(3, -1, 1)).toBe(0);
    expect(stepIndex(3, -1, -1)).toBe(2);
    expect(stepIndex(3, 2, 1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBeUndefined();
  });

  it('finds the next unviewed file after the current one', () => {
    expect(nextUnviewed([false, true, false], 0)).toBe(2);
    expect(nextUnviewed([false, true, true], 2)).toBe(0);
    expect(nextUnviewed([true, true], 0)).toBeUndefined();
    expect(nextUnviewed([false], 0)).toBeUndefined();
  });

  it('steps comments by file and line from the cursor', () => {
    const items = [
      { file: 'a.ts', startLine: 5 },
      { file: 'a.ts', startLine: 20 },
      { file: 'b.ts', startLine: 1 },
    ];
    expect(stepPosition(items, { file: 'a.ts', line: 5 }, 1)).toBe(items[1]);
    expect(stepPosition(items, { file: 'a.ts', line: 30 }, 1)).toBe(items[2]);
    expect(stepPosition(items, { file: 'b.ts', line: 1 }, 1)).toBe(items[0]);
    expect(stepPosition(items, { file: 'a.ts', line: 5 }, -1)).toBe(items[2]);
    expect(stepPosition(items, undefined, 1)).toBe(items[0]);
  });
});
