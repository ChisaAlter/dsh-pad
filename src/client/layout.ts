/**
 * Nested card layout.
 *
 * A layout is a tree of panels: a `split` lays its children out side by side
 * (`row`) or stacked (`col`), and a `leaf` is one panel. Rows may hold at most
 * three columns; columns may hold any number of stacked panels. A split with a
 * single child is collapsed, so a panel is always a leaf somewhere under a
 * split (or the whole tree).
 *
 * Everything here is pure and immutable: the dock keeps one tree in React
 * state, drops and splitter drags return a new tree, and `normalizeTree`
 * reconciles any stored tree with the panels that still exist.
 */

/** How a split arranges its children. */
export type LayoutDirection = 'row' | 'col'

/** Where a dragged card would land relative to the card under the pointer. */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface LayoutLeaf {
  readonly kind: 'leaf'
  readonly id: string
}

export interface LayoutSplit {
  readonly kind: 'split'
  readonly dir: LayoutDirection
  readonly children: readonly LayoutNode[]
  readonly weights: readonly number[]
}

export type LayoutNode = LayoutLeaf | LayoutSplit

/** A row is a column grid; more than three panels would be unreadably narrow. */
export const MAX_ROW_CHILDREN = 3
/** Deep nesting is legal but eventually loses meaning; drops then swap instead. */
const MAX_DEPTH = 8
const MAX_WEIGHT = 20
const MIN_WEIGHT = 0.05

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clampWeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, value))
}

/** One panel node. */
export function leaf(id: string): LayoutLeaf {
  return { kind: 'leaf', id }
}

export function makeSplit(dir: LayoutDirection, children: readonly LayoutNode[], weights?: readonly number[]): LayoutNode | null {
  const kept: LayoutNode[] = []
  const keptWeights: number[] = []
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child === undefined) continue
    kept.push(child)
    keptWeights.push(clampWeight(weights?.[index]))
  }
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]!
  return { kind: 'split', dir, children: kept, weights: keptWeights }
}

/** The panel ids in visual order, left to right / top to bottom. */
export function leafIds(node: LayoutNode | null): string[] {
  if (node === null) return []
  if (node.kind === 'leaf') return [node.id]
  return node.children.flatMap(child => leafIds(child))
}

export function hasLeaf(node: LayoutNode | null, id: string): boolean {
  if (node === null) return false
  if (node.kind === 'leaf') return node.id === id
  return node.children.some(child => hasLeaf(child, id))
}

/**
 * Read a persisted tree without knowing the panel list yet. Invalid nodes are
 * dropped, duplicate panels are kept only once, and the depth/column limits are
 * applied. `normalizeTree` does the same against the real panel ids.
 * @param raw - a value from localStorage.
 * @returns a usable tree, or null.
 */
export function parseTree(raw: unknown): LayoutNode | null {
  const seen = new Set<string>()
  return readNode(raw, undefined, seen, 0)
}

function readNode(raw: unknown, known: ReadonlySet<string> | undefined, seen: Set<string>, depth: number): LayoutNode | null {
  if (!isRecord(raw) || depth > MAX_DEPTH) return null
  const legacyLeaf = typeof raw['id'] === 'string' && raw['kind'] !== 'split'
  if (raw['kind'] === 'leaf' || legacyLeaf) {
    const id = raw['id']
    if (typeof id !== 'string' || id === '' || seen.has(id)) return null
    if (known !== undefined && !known.has(id)) return null
    seen.add(id)
    return leaf(id)
  }
  if (raw['kind'] !== 'split' || !Array.isArray(raw['children'])) return null
  const dir: LayoutDirection = raw['dir'] === 'col' ? 'col' : 'row'
  const children: LayoutNode[] = []
  const weights: number[] = []
  const limit = dir === 'row' ? MAX_ROW_CHILDREN : Number.POSITIVE_INFINITY
  for (let index = 0; index < raw['children'].length && children.length < limit; index += 1) {
    const child = readNode(raw['children'][index], known, seen, depth + 1)
    if (child === null) continue
    children.push(child)
    weights.push(clampWeight(Array.isArray(raw['weights']) ? raw['weights'][index] : undefined))
  }
  if (children.length === 0) return null
  if (children.length === 1) return children[0]!
  return { kind: 'split', dir, children, weights }
}

/**
 * One tree that contains every known panel exactly once: unknown/duplicate ids
 * are dropped, single-child splits collapse, and panels missing from the stored
 * tree are appended as new full-width rows at the bottom.
 * @param raw - a persisted or in-memory tree.
 * @param panelIds - every panel the dock currently renders, in display order.
 * @returns the reconciled tree, or null when there are no panels.
 */
export function normalizeTree(raw: unknown, panelIds: readonly string[]): LayoutNode | null {
  const known = [...new Set(panelIds.filter(id => id !== ''))]
  if (known.length === 0) return null
  const knownSet = new Set(known)
  const seen = new Set<string>()
  let tree = readNode(raw, knownSet, seen, 0)
  for (const id of known) {
    if (seen.has(id)) continue
    seen.add(id)
    tree = appendRoot(tree, leaf(id))
  }
  return tree
}

/**
 * Migrate the pre-nesting `rows` layout: each row became a horizontal split,
 * and the rows themselves were stacked vertically.
 * @param rows - old `{ ids, weights }` rows from localStorage.
 * @returns an equivalent tree, or null.
 */
export function legacyRowsToTree(rows: readonly { readonly ids: readonly string[]; readonly weights: readonly number[] }[]): LayoutNode | null {
  const seen = new Set<string>()
  const rowNodes: LayoutNode[] = []
  for (const row of rows) {
    const ids: string[] = []
    const weights: number[] = []
    row.ids.forEach((id, index) => {
      if (id === '' || seen.has(id)) return
      seen.add(id)
      ids.push(id)
      weights.push(clampWeight(row.weights[index]))
    })
    // Old rows had no column limit; the nested layout has one. Keep every
    // panel, but carry overflow onto extra full-width rows instead of
    // persisting a row that the tree reader would have to trim later.
    for (let start = 0; start < ids.length; start += MAX_ROW_CHILDREN) {
      const chunkIds = ids.slice(start, start + MAX_ROW_CHILDREN)
      const chunkWeights = weights.slice(start, start + MAX_ROW_CHILDREN)
      const node = makeSplit('row', chunkIds.map(leaf), chunkWeights)
      if (node !== null) rowNodes.push(node)
    }
  }
  return makeSplit('col', rowNodes)
}

/** Add one node as a full-width row under the root. */
export function appendRoot(tree: LayoutNode | null, node: LayoutNode): LayoutNode {
  if (tree === null) return node
  if (tree.kind === 'split' && tree.dir === 'col') {
    return {
      kind: 'split',
      dir: 'col',
      children: [...tree.children, node],
      weights: [...tree.weights, 1],
    }
  }
  return { kind: 'split', dir: 'col', children: [tree, node], weights: [1, 1] }
}

export function removeLeaf(tree: LayoutNode, id: string): LayoutNode | null {
  if (tree.kind === 'leaf') return tree.id === id ? null : tree
  const children: LayoutNode[] = []
  const weights: number[] = []
  tree.children.forEach((child, index) => {
    const next = removeLeaf(child, id)
    if (next === null) return
    children.push(next)
    weights.push(tree.weights[index] ?? 1)
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]!
  return { kind: 'split', dir: tree.dir, children, weights }
}

/** Swap two panels' places, used by a drop in the middle of a card. */
export function swapLeaves(tree: LayoutNode, a: string, b: string): LayoutNode {
  if (tree.kind === 'leaf') {
    if (tree.id === a) return leaf(b)
    if (tree.id === b) return leaf(a)
    return tree
  }
  return {
    kind: 'split',
    dir: tree.dir,
    children: tree.children.map(child => swapLeaves(child, a, b)),
    weights: tree.weights,
  }
}

interface Located {
  readonly depth: number
  readonly parent: LayoutSplit | null
  readonly index: number
}

function locate(tree: LayoutNode, id: string, parent: LayoutSplit | null = null, depth = 0, index = -1): Located | null {
  if (tree.kind === 'leaf') return tree.id === id ? { depth, parent, index } : null
  for (let position = 0; position < tree.children.length; position += 1) {
    const child = tree.children[position]!
    const found = locate(child, id, tree, depth + 1, position)
    if (found !== null) return found
  }
  return null
}

/**
 * Move a card next to another one, splitting the target card's area.
 *
 * When the target already sits in a split of the wanted direction with room
 * left, the card is inserted beside it; otherwise the target is wrapped in a
 * new split. That is what lets two columns become a left stack plus a right
 * column: drop on the left card's right edge first, then drop the lower card on
 * the upper card's bottom edge.
 * @param tree - the current tree.
 * @param sourceId - the card being dragged.
 * @param targetId - the card under the pointer.
 * @param zone - which edge of the target the pointer is on.
 * @returns the new tree; the old one when the move is impossible.
 */
export function dropOnLeaf(tree: LayoutNode, sourceId: string, targetId: string, zone: DropZone): LayoutNode {
  if (sourceId === targetId) return tree
  if (!hasLeaf(tree, sourceId) || !hasLeaf(tree, targetId)) return tree
  if (zone === 'center') return swapLeaves(tree, sourceId, targetId)

  const dir: LayoutDirection = zone === 'left' || zone === 'right' ? 'row' : 'col'
  const before = zone === 'left' || zone === 'top'
  const base = removeLeaf(tree, sourceId)
  if (base === null) return tree
  const target = locate(base, targetId)
  if (target === null || target.depth >= MAX_DEPTH) return swapLeaves(tree, sourceId, targetId)

  const source = leaf(sourceId)
  const parent = target.parent
  const canJoin = parent !== null
    && parent.dir === dir
    && (dir === 'col' || parent.children.length < MAX_ROW_CHILDREN)

  if (canJoin && parent !== null) {
    const children = [...parent.children]
    const weights = [...parent.weights]
    const at = before ? target.index : target.index + 1
    children.splice(at, 0, source)
    weights.splice(at, 0, 1)
    return replaceNode(base, parent, { kind: 'split', dir: parent.dir, children, weights })
  }

  // Wrap the target where it is: the dragged card takes the requested side.
  const replacement = makeSplit(dir, before ? [source, leaf(targetId)] : [leaf(targetId), source])
  if (replacement === null) return tree
  return replaceLeaf(base, targetId, replacement)
}

/** Replace one leaf by id (the tree is immutable, so the returned tree is new). */
function replaceLeaf(root: LayoutNode, id: string, replacement: LayoutNode): LayoutNode {
  if (root.kind === 'leaf') return root.id === id ? replacement : root
  let changed = false
  const children = root.children.map(child => {
    const next = replaceLeaf(child, id, replacement)
    if (next !== child) changed = true
    return next
  })
  return changed ? { kind: 'split', dir: root.dir, children, weights: root.weights } : root
}

/** Move a card to the bottom of the whole layout (a full-width row). */
export function moveToRoot(tree: LayoutNode, sourceId: string): LayoutNode {
  if (!hasLeaf(tree, sourceId)) return tree
  const base = removeLeaf(tree, sourceId)
  return base === null ? leaf(sourceId) : appendRoot(base, leaf(sourceId))
}

/** Replace a subtree by reference (the tree is immutable, so identity works). */
function replaceNode(root: LayoutNode, target: LayoutNode, replacement: LayoutNode): LayoutNode {
  if (root === target) return replacement
  if (root.kind === 'leaf') return root
  let changed = false
  const children = root.children.map(child => {
    const next = replaceNode(child, target, replacement)
    if (next !== child) changed = true
    return next
  })
  return changed ? { kind: 'split', dir: root.dir, children, weights: root.weights } : root
}

/** The split node at an index path, e.g. `[0, 1]`; null when it is not a split. */
export function nodeAtPath(tree: LayoutNode, path: readonly number[]): LayoutNode | null {
  let node: LayoutNode = tree
  for (const index of path) {
    if (node.kind !== 'split') return null
    const child = node.children[index]
    if (child === undefined) return null
    node = child
  }
  return node
}

/** Replace one split's child weights, addressed by its path. */
export function withWeightsAtPath(tree: LayoutNode, path: readonly number[], weights: readonly number[]): LayoutNode {
  if (path.length === 0) {
    if (tree.kind !== 'split') return tree
    return { kind: 'split', dir: tree.dir, children: tree.children, weights: applyWeights(tree.children.length, weights) }
  }
  if (tree.kind !== 'split') return tree
  const [head, ...rest] = path
  if (head === undefined || tree.children[head] === undefined) return tree
  return {
    kind: 'split',
    dir: tree.dir,
    children: tree.children.map((child, index) => index === head ? withWeightsAtPath(child, rest, weights) : child),
    weights: tree.weights,
  }
}

function applyWeights(count: number, weights: readonly number[]): number[] {
  return Array.from({ length: count }, (_, index) => clampWeight(weights[index]))
}

/**
 * Which part of a card the pointer is over. The outer 30% of each side is a
 * split zone; everything inside is a swap.
 * @param rect - the card's bounding box.
 * @param x - pointer client x.
 * @param y - pointer client y.
 * @param edge - fraction of each side that counts as a split zone.
 * @returns the drop zone.
 */
export function dropZoneFor(rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }, x: number, y: number, edge = 0.3): DropZone {
  if (rect.width <= 0 || rect.height <= 0) return 'center'
  const fx = Math.min(1, Math.max(0, (x - rect.left) / rect.width))
  const fy = Math.min(1, Math.max(0, (y - rect.top) / rect.height))
  const candidates: [DropZone, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ]
  candidates.sort((a, b) => a[1] - b[1])
  const nearest = candidates[0]!
  return nearest[1] <= edge ? nearest[0] : 'center'
}

/** Total weight of a split, never zero. */
export function totalWeight(split: LayoutSplit): number {
  return split.weights.reduce((sum, weight) => sum + clampWeight(weight), 0) || 1
}
