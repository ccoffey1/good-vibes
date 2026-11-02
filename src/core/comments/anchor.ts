export interface AnchorRange {
  startLine: number;
  endLine: number;
}

export interface Reanchored extends AnchorRange {
  outdated: boolean;
}

/** Text of 1-based inclusive lines, joined with '\n'. */
export function extractLines(lines: readonly string[], range: AnchorRange): string {
  return lines.slice(range.startLine - 1, range.endLine).join('\n');
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * Follows anchored code after edits: keeps the range if the text is still there, otherwise moves
 * to the closest exact match of the anchor text, otherwise marks the thread outdated in place.
 */
export function reanchor(lines: readonly string[], range: AnchorRange, anchor: string): Reanchored {
  if (extractLines(lines, range) === anchor) return { ...range, outdated: false };

  const anchorLines = splitLines(anchor);
  const height = anchorLines.length;
  let best: number | undefined;
  for (let start = 0; start + height <= lines.length; start++) {
    if (lines[start] !== anchorLines[0]) continue;
    if (!anchorLines.every((line, offset) => lines[start + offset] === line)) continue;
    const distance = Math.abs(start + 1 - range.startLine);
    if (best === undefined || distance < Math.abs(best + 1 - range.startLine)) best = start;
  }
  if (best !== undefined) return { startLine: best + 1, endLine: best + height, outdated: false };

  const lastLine = Math.max(1, lines.length);
  const startLine = Math.min(range.startLine, lastLine);
  return { startLine, endLine: Math.min(Math.max(range.endLine, startLine), lastLine), outdated: true };
}
