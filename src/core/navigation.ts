/** Pure ordering rules for stepping through files and comments. */

export interface Position {
  file: string;
  line: number;
}

/** Index of the next (or previous) item, wrapping around; starts at the first/last when nothing is current. */
export function stepIndex(length: number, current: number, direction: 1 | -1): number | undefined {
  if (length === 0) return undefined;
  if (current < 0) return direction === 1 ? 0 : length - 1;
  return (current + direction + length) % length;
}

/** Next unviewed item after `current` (wrapping), never `current` itself. */
export function nextUnviewed(viewed: readonly boolean[], current: number): number | undefined {
  for (let offset = 1; offset <= viewed.length; offset++) {
    const index = (Math.max(current, -1) + offset) % viewed.length;
    if (index !== current && viewed[index] === false) return index;
  }
  return undefined;
}

/**
 * Next comment strictly after (or before) a cursor position, ordered by file then line, wrapping.
 * `items` must already be sorted that way.
 */
export function stepPosition<T extends { file: string; startLine: number }>(items: readonly T[], at: Position | undefined, direction: 1 | -1): T | undefined {
  if (items.length === 0) return undefined;
  if (!at) return direction === 1 ? items[0] : items.at(-1);
  const compare = (item: T) => item.file.localeCompare(at.file) || item.startLine - at.line;
  if (direction === 1) return items.find((item) => compare(item) > 0) ?? items[0];
  return [...items].reverse().find((item) => compare(item) < 0) ?? items.at(-1);
}
