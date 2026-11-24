/**
 * Pure geometry for a vertically continuous PDF page stack.
 *
 * Page sizes are expressed at scale 1 (PDF points); layout entries carry the
 * scaled width/height and the cumulative top offset used by the scroll
 * container. Positions may be fractional because zooming and scrolling rarely
 * land on whole pixels.
 */

export type PageSize = { width: number; height: number }

export type PageLayoutEntry = {
  /** 1-based page number. */
  page: number
  /** Top offset in scaled CSS pixels, relative to the document stack. */
  top: number
  width: number
  height: number
}

export type ReadingAnchor = {
  /** 1-based page number; 0 when the document has no pages. */
  page: number
  /** Fraction of the page height that is scrolled past, in [0, 1]. */
  fraction: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function layoutPages(sizes: PageSize[], scale: number): PageLayoutEntry[] {
  let top = 0
  return sizes.map((size, index) => {
    const width = size.width * scale
    const height = size.height * scale
    const entry = { page: index + 1, top, width, height }
    top += height
    return entry
  })
}

export function totalLayoutHeight(layout: PageLayoutEntry[]): number {
  if (layout.length === 0) return 0
  const last = layout[layout.length - 1]
  return last.top + last.height
}

/**
 * Resolves the scroll offset for the top of a page plus an optional fraction
 * of that page's height. Out-of-range pages and fractions are clamped.
 */
export function layoutOffsetFor(layout: PageLayoutEntry[], page: number, fraction = 0): number {
  if (layout.length === 0) return 0
  const index = clamp(Math.trunc(page) - 1, 0, layout.length - 1)
  const entry = layout[index]
  return entry.top + entry.height * clamp(fraction, 0, 1)
}

/**
 * Resolves a scroll offset to the page that owns it and the fractional
 * position within that page. At a shared boundary the later page wins, which
 * matches what is actually visible at the top of the reader.
 */
export function layoutAnchorAt(layout: PageLayoutEntry[], offset: number): ReadingAnchor {
  if (layout.length === 0) return { page: 0, fraction: 0 }

  const total = totalLayoutHeight(layout)
  const clamped = clamp(offset, 0, total)
  if (clamped >= total) {
    return { page: layout[layout.length - 1].page, fraction: 1 }
  }

  // Binary search for the greatest entry whose top is at or before the offset.
  let low = 0
  let high = layout.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (layout[mid].top <= clamped) low = mid
    else high = mid - 1
  }

  const entry = layout[low]
  const fraction = entry.height > 0 ? (clamped - entry.top) / entry.height : 0
  return { page: entry.page, fraction: clamp(fraction, 0, 1) }
}

export function layoutPageAt(layout: PageLayoutEntry[], offset: number): number {
  return layoutAnchorAt(layout, offset).page
}
