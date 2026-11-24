import { describe, expect, it } from 'vitest'
import {
  layoutAnchorAt,
  layoutOffsetFor,
  layoutPageAt,
  layoutPages,
  totalLayoutHeight,
  type PageSize
} from '../../src/renderer/continuous-layout'

const uniform: PageSize[] = [
  { width: 600, height: 800 },
  { width: 600, height: 800 },
  { width: 600, height: 800 }
]

const mixed: PageSize[] = [
  { width: 600, height: 800 },
  { width: 600, height: 600 },
  { width: 600, height: 1000 }
]

describe('continuous layout geometry', () => {
  it('stacks equal pages with no gap at the requested scale', () => {
    const layout = layoutPages(uniform, 1.5)
    expect(layout).toEqual([
      { page: 1, top: 0, width: 900, height: 1200 },
      { page: 2, top: 1200, width: 900, height: 1200 },
      { page: 3, top: 2400, width: 900, height: 1200 }
    ])
    expect(totalLayoutHeight(layout)).toBe(3600)
  })

  it('reserves mixed page heights and width per page', () => {
    const layout = layoutPages(mixed, 1)
    expect(layout.map(entry => entry.top)).toEqual([0, 800, 1400])
    expect(layout.map(entry => entry.height)).toEqual([800, 600, 1000])
    expect(totalLayoutHeight(layout)).toBe(2400)
  })

  it('scales widths and heights independently of offsets', () => {
    const layout = layoutPages(mixed, 2)
    expect(layout.map(entry => entry.width)).toEqual([1200, 1200, 1200])
    expect(layout.map(entry => entry.top)).toEqual([0, 1600, 2800])
    expect(layout.map(entry => entry.height)).toEqual([1600, 1200, 2000])
  })
})

describe('page lookup', () => {
  const layout = layoutPages(mixed, 1)

  it('finds the page that owns an offset', () => {
    expect(layoutPageAt(layout, 0)).toBe(1)
    expect(layoutPageAt(layout, 799)).toBe(1)
    expect(layoutPageAt(layout, 800)).toBe(2)
    expect(layoutPageAt(layout, 1399)).toBe(2)
    expect(layoutPageAt(layout, 1400)).toBe(3)
    expect(layoutPageAt(layout, 2399)).toBe(3)
    expect(layoutPageAt(layout, 2400)).toBe(3)
  })

  it('clamps offsets outside the document', () => {
    expect(layoutAnchorAt(layout, -50)).toEqual({ page: 1, fraction: 0 })
    expect(layoutAnchorAt(layout, 99999)).toEqual({ page: 3, fraction: 1 })
    expect(layoutPageAt(layout, -50)).toBe(1)
    expect(layoutPageAt(layout, 99999)).toBe(3)
  })

  it('reports the fractional position inside a page', () => {
    expect(layoutAnchorAt(layout, 0)).toEqual({ page: 1, fraction: 0 })
    expect(layoutAnchorAt(layout, 200)).toEqual({ page: 1, fraction: 0.25 })
    expect(layoutAnchorAt(layout, 1100)).toEqual({ page: 2, fraction: 0.5 })
    expect(layoutAnchorAt(layout, 2400)).toEqual({ page: 3, fraction: 1 })
  })

  it('handles an empty document', () => {
    expect(layoutPages([], 1)).toEqual([])
    expect(totalLayoutHeight([])).toBe(0)
    expect(layoutAnchorAt([], 120)).toEqual({ page: 0, fraction: 0 })
    expect(layoutOffsetFor([], 1, 0)).toBe(0)
    expect(layoutPageAt([], 120)).toBe(0)
  })
})

describe('offset round-tripping', () => {
  const layout = layoutPages(mixed, 1)

  it('returns the original offset for top-anchored pages', () => {
    for (const page of [1, 2, 3]) {
      const offset = layoutOffsetFor(layout, page, 0)
      expect(layoutAnchorAt(layout, offset)).toEqual({ page, fraction: 0 })
    }
  })

  it('returns the original offset for in-page fractions', () => {
    for (const [page, fraction] of [[1, 0.25], [2, 0.5], [3, 0.75], [3, 0.99]] as const) {
      const offset = layoutOffsetFor(layout, page, fraction)
      const anchor = layoutAnchorAt(layout, offset)
      expect(anchor.page).toBe(page)
      expect(anchor.fraction).toBeCloseTo(fraction, 10)
    }
  })

  it('clamps page and fraction inputs into the document', () => {
    expect(layoutOffsetFor(layout, 0, 0)).toBe(0)
    expect(layoutOffsetFor(layout, 99, 0)).toBe(1400)
    expect(layoutOffsetFor(layout, 1, -1)).toBe(0)
    expect(layoutOffsetFor(layout, 1, 2)).toBe(800)
  })
})

describe('zoom anchor round-tripping', () => {
  it('preserves the top page and fractional offset across a scale change', () => {
    const before = layoutPages(mixed, 1)
    const anchor = layoutAnchorAt(before, 1040) // page 2, 40% down
    expect(anchor.page).toBe(2)
    expect(anchor.fraction).toBeCloseTo(0.4, 10)

    const after = layoutPages(mixed, 2)
    const restored = layoutAnchorAt(after, layoutOffsetFor(after, anchor.page, anchor.fraction))
    expect(restored.page).toBe(2)
    expect(restored.fraction).toBeCloseTo(anchor.fraction, 10)
  })

  it('keeps the first and last page anchors stable', () => {
    const before = layoutPages(mixed, 1)
    const after = layoutPages(mixed, 1.75)

    const first = layoutAnchorAt(before, 0)
    expect(layoutAnchorAt(after, layoutOffsetFor(after, first.page, first.fraction))).toEqual({ page: 1, fraction: 0 })

    const last = layoutAnchorAt(before, 2400)
    expect(layoutAnchorAt(after, layoutOffsetFor(after, last.page, last.fraction))).toEqual({ page: 3, fraction: 1 })
  })
})
