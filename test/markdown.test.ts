import { describe, expect, it } from 'vitest';
import { languageForFile, tagCodeFences } from '../src/core/comments/markdown';

describe('tagCodeFences', () => {
  it('tags untagged opening fences and leaves closing and tagged fences alone', () => {
    const input = ['Try:', '```', 'const a = 1;', '```', '', '```json', '{}', '```'].join('\n');
    expect(tagCodeFences(input, 'typescript')).toBe(['Try:', '```typescript', 'const a = 1;', '```', '', '```json', '{}', '```'].join('\n'));
  });

  it('does not treat a shorter or different fence as closing', () => {
    const input = ['````', '```', 'nested', '```', '````'].join('\n');
    expect(tagCodeFences(input, 'ts')).toBe(['````ts', '```', 'nested', '```', '````'].join('\n'));
  });

  it('is a no-op without a language', () => {
    expect(tagCodeFences('```\nx\n```', undefined)).toBe('```\nx\n```');
  });

  it('maps file extensions to fence languages', () => {
    expect(languageForFile('src/a.tsx')).toBe('tsx');
    expect(languageForFile('lib/x.DART')).toBe('dart');
    expect(languageForFile('Makefile')).toBeUndefined();
  });
});
