import { describe, expect, it } from 'vitest'
import {
  dropOnLeaf,
  dropZoneFor,
  leaf,
  leafIds,
  legacyRowsToTree,
  makeSplit,
  moveToRoot,
  nodeAtPath,
  normalizeTree,
  normalizedWeights,
  parseTree,
  rowTemplate,
  removeLeaf,
  swapLeaves,
  totalWeight,
  withWeightsAtPath,
  type LayoutNode,
} from '../src/client/layout.ts'

const l = (id: string): LayoutNode => leaf(id)
const row = (...children: LayoutNode[]): LayoutNode => makeSplit('row', children)!
const col = (...children: LayoutNode[]): LayoutNode => makeSplit('col', children)!

describe('layout tree', () => {
  it('migrates the old rows layout, preserving each row and its weights', () => {
    const tree = legacyRowsToTree([
      { ids: ['a', 'b'], weights: [2, 1] },
      { ids: ['c'], weights: [1] },
    ])
    expect(tree).toEqual({
      kind: 'split', dir: 'col', weights: [1, 1],
      children: [
        { kind: 'split', dir: 'row', weights: [2, 1], children: [l('a'), l('b')] },
        l('c'),
      ],
    })
    expect(normalizeTree(tree, ['a', 'b', 'c'])).toEqual(tree)
  })

  it('splits an oversized legacy row into a legal row plus a full-width row', () => {
    const tree = legacyRowsToTree([{ ids: ['a', 'b', 'c', 'd'], weights: [1, 2, 1, 1] }])
    const first = makeSplit('row', [l('a'), l('b'), l('c')], [1, 2, 1])
    expect(tree).toEqual(col(first!, l('d')))
    expect(leafIds(tree)).toEqual(['a', 'b', 'c', 'd'])
    expect(normalizeTree(tree, ['a', 'b', 'c', 'd'])).toEqual(tree)
  })

  it('drops unknown and duplicate panels, then appends missing ones at the bottom', () => {
    const raw = { kind: 'split', dir: 'row', weights: [1, 1, 1], children: [l('a'), l('x'), l('a'), l('b')] }
    const tree = normalizeTree(raw, ['a', 'b', 'c'])
    expect(tree).toEqual(col(row(l('a'), l('b')), l('c')))
    expect(normalizeTree(null, ['a', 'b'])).toEqual(col(l('a'), l('b')))
    expect(normalizeTree(raw, [])).toBeNull()
  })

  it('collapses rows past three columns and keeps every panel', () => {
    const raw = row(l('a'), l('b'), l('c'), l('d'))
    const tree = normalizeTree(raw, ['a', 'b', 'c', 'd'])
    expect(leafIds(tree)).toEqual(['a', 'b', 'c', 'd'])
    expect(nodeAtPath(tree!, [0])).toEqual(row(l('a'), l('b'), l('c')))
  })

  it('reads a stored tree permissively but clamps weights', () => {
    const tree = parseTree({
      kind: 'split', dir: 'col', weights: [-4, 'x', 50],
      children: [
        { kind: 'split', dir: 'row', weights: [2], children: [l('a'), l('b')] },
        l('c'),
        l('d'),
      ],
    })
    expect(tree).toEqual({
      kind: 'split', dir: 'col', weights: [1, 1, 20],
      children: [{ kind: 'split', dir: 'row', weights: [2, 1], children: [l('a'), l('b')] }, l('c'), l('d')],
    })
    expect(parseTree('nonsense')).toBeNull()
  })

  it('builds a left stack plus an independent right column with two drops', () => {
    const flat = normalizeTree(null, ['a', 'b', 'c'])!
    const afterC = dropOnLeaf(flat, 'c', 'a', 'right')
    expect(leafIds(afterC)).toEqual(['a', 'c', 'b'])
    const nested = dropOnLeaf(afterC, 'b', 'a', 'bottom')
    expect(nested).toEqual(col(row(col(l('a'), l('b')), l('c'))))
    expect(leafIds(nested)).toEqual(['a', 'b', 'c'])
  })

  it('turns a three-column row into a left stack plus right column in one drop', () => {
    const base = row(l('a'), l('b'), l('c'))
    expect(dropOnLeaf(base, 'b', 'a', 'bottom')).toEqual(row(col(l('a'), l('b')), l('c')))
  })

  it('reorders inside a row before wrapping a card', () => {
    const base = row(l('a'), l('b'), l('c'))
    expect(dropOnLeaf(base, 'a', 'b', 'right')).toEqual(row(l('b'), l('a'), l('c')))
    expect(dropOnLeaf(base, 'c', 'a', 'left')).toEqual(row(l('c'), l('a'), l('b')))
  })

  it('wraps a card in a column when the row has no room', () => {
    const base = col(row(l('a'), l('b'), l('c')), l('d'))
    expect(dropOnLeaf(base, 'd', 'b', 'right')).toEqual(col(row(l('a'), row(l('b'), l('d')), l('c'))))
    expect(dropOnLeaf(base, 'd', 'b', 'left')).toEqual(col(row(l('a'), row(l('d'), l('b')), l('c'))))
  })

  it('swaps two cards when dropped in the middle', () => {
    const base = col(row(l('a'), l('b')), l('c'))
    expect(dropOnLeaf(base, 'a', 'c', 'center')).toEqual(col(row(l('c'), l('b')), l('a')))
    expect(swapLeaves(base, 'a', 'b')).toEqual(col(row(l('b'), l('a')), l('c')))
  })

  it('moves a card to the bottom of the layout', () => {
    const base = col(row(l('a'), l('b')), l('c'))
    expect(moveToRoot(base, 'b')).toEqual(col(l('a'), l('c'), l('b')))
    expect(moveToRoot(row(l('a'), l('b')), 'a')).toEqual(col(l('b'), l('a')))
  })

  it('removes panels and collapses empty or single-child splits', () => {
    const base = col(row(l('a'), l('b')), l('c'))
    expect(removeLeaf(base, 'c')).toEqual(row(l('a'), l('b')))
    expect(removeLeaf(row(l('a'), l('b')), 'a')).toEqual(l('b'))
    expect(removeLeaf(l('a'), 'a')).toBeNull()
    expect(removeLeaf(base, 'x')).toEqual(base)
  })

  it('updates one split’s weights by path', () => {
    const base = col(row(l('a'), l('b')), row(l('c'), l('d')))
    const next = withWeightsAtPath(base, [1], [3, 1])
    expect(nodeAtPath(next, [1])).toEqual({ kind: 'split', dir: 'row', children: [l('c'), l('d')], weights: [3, 1] })
    expect(nodeAtPath(next, [0])).toEqual(row(l('a'), l('b')))
    const split = nodeAtPath(next, [1])
    if (split?.kind !== 'split') throw new Error('expected a split')
    expect(totalWeight(split)).toBe(4)
  })

  it('clamps splitter weights and ignores a non-split path', () => {
    const base = row(l('a'), l('b'))
    expect(withWeightsAtPath(base, [0], [9, 9])).toEqual(base)
    expect(withWeightsAtPath(base, [], [-1, 2])).toEqual({
      kind: 'split', dir: 'row', children: [l('a'), l('b')], weights: [1, 2],
    })
  })

  it('fills a row after a large sibling is removed, keeping the remaining ratio', () => {
    const before = makeSplit('row', [l('a'), l('b'), l('c')], [1.5, 0.25, 0.25])!
    const after = removeLeaf(before, 'a')
    if (after?.kind !== 'split') throw new Error('expected a split')
    expect(after.weights).toEqual([0.25, 0.25])
    expect(rowTemplate(after, 6)).toBe('minmax(0, 1fr) 6px minmax(0, 1fr)')
    expect(normalizedWeights(after)).toEqual([1, 1])
  })

  it('uses the same proportions at any saved weight scale', () => {
    for (const weights of [[0.1, 0.4], [1, 4], [4, 16]]) {
      const split = makeSplit('row', [l('a'), l('b')], weights)
      if (split?.kind !== 'split') throw new Error('expected a split')
      expect(rowTemplate(split, 6)).toBe('minmax(0, 0.4fr) 6px minmax(0, 1.6fr)')
    }
  })

  it('lets a fractional row reach the 80px pane minimum without weight clamping', () => {
    const split = makeSplit('row', [l('a'), l('b')], [0.25, 0.25])
    if (split?.kind !== 'split') throw new Error('expected a split')
    const weights = normalizedWeights(split)
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    const cardArea = 960
    const rightWeight = 80 / cardArea * total
    const resized = withWeightsAtPath(split, [], [total - rightWeight, rightWeight])
    if (resized.kind !== 'split') throw new Error('expected a split')
    expect(resized.weights[1]! / totalWeight(resized) * cardArea).toBeCloseTo(80)
  })

  it('turns pointer positions into drop zones', () => {
    const rect = { left: 100, top: 100, width: 200, height: 200 }
    expect(dropZoneFor(rect, 110, 200)).toBe('left')
    expect(dropZoneFor(rect, 290, 200)).toBe('right')
    expect(dropZoneFor(rect, 200, 110)).toBe('top')
    expect(dropZoneFor(rect, 200, 290)).toBe('bottom')
    expect(dropZoneFor(rect, 200, 200)).toBe('center')
    expect(dropZoneFor({ ...rect, width: 0 }, 0, 0)).toBe('center')
  })
})
