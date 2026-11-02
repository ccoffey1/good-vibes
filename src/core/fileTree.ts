/** Builds a directory tree from file paths, for the "view as tree" mode of the file list. */

export interface FolderNode<T> {
  kind: 'folder';
  /** Display name; chains of single-child folders are compacted into one node, e.g. `src/core`. */
  name: string;
  /** Repo-relative path of the deepest folder in the compacted chain. */
  path: string;
  children: TreeNode<T>[];
}

export interface FileNode<T> {
  kind: 'file';
  name: string;
  item: T;
}

export type TreeNode<T> = FolderNode<T> | FileNode<T>;

/** Folders first, then files, each alphabetically; single-child folder chains are compacted. */
export function buildFileTree<T>(items: readonly T[], pathOf: (item: T) => string): TreeNode<T>[] {
  const root: FolderNode<T> = { kind: 'folder', name: '', path: '', children: [] };
  for (const item of items) {
    const segments = pathOf(item).split('/');
    const name = segments.pop() ?? '';
    let folder = root;
    for (const segment of segments) {
      let next = folder.children.find((c): c is FolderNode<T> => c.kind === 'folder' && c.name === segment);
      if (!next) {
        next = { kind: 'folder', name: segment, path: folder.path ? `${folder.path}/${segment}` : segment, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ kind: 'file', name, item });
  }
  return finalize(root.children);
}

function finalize<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  return nodes
    .map((node) => (node.kind === 'folder' ? compact(node) : node))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
}

function compact<T>(folder: FolderNode<T>): FolderNode<T> {
  let current = folder;
  let name = folder.name;
  while (current.children.length === 1 && current.children[0]?.kind === 'folder') {
    current = current.children[0];
    name = `${name}/${current.name}`;
  }
  return { kind: 'folder', name, path: current.path, children: finalize(current.children) };
}

/** Files in display order (depth-first), so navigation matches what the tree shows. */
export function flattenTree<T>(nodes: readonly TreeNode<T>[]): T[] {
  return nodes.flatMap((node) => (node.kind === 'file' ? [node.item] : flattenTree(node.children)));
}
