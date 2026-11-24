import { describe, expect, it, vi } from 'vitest'
import {
  collectInternalLinks,
  rectToNormalizedBox,
  resolveDestinationPage,
  type LinkDestination,
  type ViewportLike
} from '../../src/renderer/pdf-links'

type FakeDocument = {
  numPages: number
  getDestination: ReturnType<typeof vi.fn>
  getPageIndex: ReturnType<typeof vi.fn>
}

/** Minimal stand-in for PDFDocumentProxy; no PDF.js runtime is imported. */
function fakeDocument(overrides: Partial<FakeDocument> = {}): FakeDocument {
  return {
    numPages: 10,
    getDestination: vi.fn(async (): Promise<unknown[] | null> => null),
    getPageIndex: vi.fn(async (): Promise<number> => 0),
    ...overrides
  }
}

/** Viewport double: width/height plus a user-space to viewport transform. */
function viewport(
  width: number,
  height: number,
  convert: (x: number, y: number) => readonly [number, number]
): ViewportLike {
  return { width, height, convertToViewportPoint: convert }
}

const PAGE_REF = { num: 16, gen: 0 }
const EXPLICIT = [{ num: 14, gen: 0 }, { name: 'XYZ' }, 0, 792, 0]

describe('resolveDestinationPage: named destinations', () => {
  it('resolves a named destination through getDestination and getPageIndex', async () => {
    const doc = fakeDocument({
      getDestination: vi.fn(async () => [{ num: 16, gen: 0 }, { name: 'Fit' }]),
      getPageIndex: vi.fn(async () => 3)
    })

    await expect(resolveDestinationPage(doc, 'chapter-two')).resolves.toBe(4)
    expect(doc.getDestination).toHaveBeenCalledWith('chapter-two')
    // Zero-based page index 3 from getPageIndex must surface as 1-based page 4.
    expect(doc.getPageIndex).toHaveBeenCalledWith(PAGE_REF)
  })

  it('returns null when a named destination is not in the document', async () => {
    const doc = fakeDocument({ getDestination: vi.fn(async () => null) })
    await expect(resolveDestinationPage(doc, 'missing-chapter')).resolves.toBeNull()
    expect(doc.getPageIndex).not.toHaveBeenCalled()
  })

  it('propagates genuine fetch errors from getDestination', async () => {
    const doc = fakeDocument({
      getDestination: vi.fn(async () => { throw new Error('worker unavailable') })
    })
    await expect(resolveDestinationPage(doc, 'chapter-two')).rejects.toThrow('worker unavailable')
  })
})

describe('resolveDestinationPage: explicit destination arrays', () => {
  it('resolves a page reference through getPageIndex', async () => {
    const doc = fakeDocument({ getPageIndex: vi.fn(async () => 2) })
    await expect(resolveDestinationPage(doc, EXPLICIT as unknown[])).resolves.toBe(3)
    expect(doc.getPageIndex).toHaveBeenCalledWith({ num: 14, gen: 0 })
  })

  it('treats a numeric first element as a zero-based page index', async () => {
    const doc = fakeDocument()
    await expect(resolveDestinationPage(doc, [0, { name: 'Fit' }])).resolves.toBe(1)
    await expect(resolveDestinationPage(doc, [2, { name: 'Fit' }])).resolves.toBe(3)
    await expect(resolveDestinationPage(doc, [9, { name: 'Fit' }])).resolves.toBe(10)
    // Numeric destinations never need a page-index lookup.
    expect(doc.getPageIndex).not.toHaveBeenCalled()
  })

  it('treats an out-of-range page index as malformed', async () => {
    const doc = fakeDocument()
    await expect(resolveDestinationPage(doc, [10, { name: 'Fit' }])).resolves.toBeNull()
    await expect(resolveDestinationPage(doc, [-1, { name: 'Fit' }])).resolves.toBeNull()
    await expect(resolveDestinationPage(doc, [1.5, { name: 'Fit' }])).resolves.toBeNull()
    await expect(resolveDestinationPage(doc, [Number.NaN, { name: 'Fit' }])).resolves.toBeNull()
  })

  it('rejects malformed destination arrays', async () => {
    const doc = fakeDocument()
    await expect(resolveDestinationPage(doc, [])).resolves.toBeNull()
    await expect(resolveDestinationPage(doc, [null, { name: 'Fit' }])).resolves.toBeNull()
    await expect(resolveDestinationPage(doc, [{ num: '14', gen: 0 }, { name: 'Fit' }])).resolves.toBeNull()
    await expect(resolveDestinationPage(doc, [{ num: 14 }, { name: 'Fit' }])).resolves.toBeNull()
    // A non-string, non-array destination is not resolvable.
    await expect(resolveDestinationPage(doc, 42 as unknown as LinkDestination)).resolves.toBeNull()
  })

  it('treats an unresolvable page reference as an invalid target', async () => {
    const rejecting = fakeDocument({
      getPageIndex: vi.fn(async () => { throw new Error('The reference does not point to a /Page dictionary.') })
    })
    await expect(resolveDestinationPage(rejecting, [{ num: 999, gen: 0 }, { name: 'XYZ' }])).resolves.toBeNull()

    const outOfRange = fakeDocument({ getPageIndex: vi.fn(async () => 10) })
    await expect(resolveDestinationPage(outOfRange, [{ num: 14, gen: 0 }, { name: 'XYZ' }])).resolves.toBeNull()

    const negative = fakeDocument({ getPageIndex: vi.fn(async () => -1) })
    await expect(resolveDestinationPage(negative, [{ num: 14, gen: 0 }, { name: 'XYZ' }])).resolves.toBeNull()
  })
})

describe('collectInternalLinks: annotation filtering', () => {
  const links: unknown[] = [
    {
      id: '5R',
      subtype: 'Link',
      rect: [72, 640, 320, 672],
      dest: [{ num: 14, gen: 0 }, { name: 'XYZ' }, 0, 792, 0]
    },
    { id: '6R', subtype: 'Link', rect: [72, 596, 320, 628], dest: 'chapter-two' },
    { id: '7R', subtype: 'Link', rect: [72, 552, 320, 584], dest: 'missing-chapter' },
    // External URI: has a target URL and must be skipped entirely.
    {
      id: '8R',
      subtype: 'Link',
      rect: [72, 464, 320, 496],
      url: 'https://example.com/mimosa-external-link',
      unsafeUrl: 'https://example.com/mimosa-external-link'
    },
    // A link that only exposes unsafeUrl is still external.
    { id: '9R', subtype: 'Link', rect: [72, 420, 320, 452], unsafeUrl: 'javascript:alert(1)' },
    // Wrong annotation subtype.
    { id: '10R', subtype: 'Text', rect: [0, 0, 10, 10], dest: 'chapter-two' },
    // Missing / malformed destinations.
    { id: '11R', subtype: 'Link', rect: [0, 0, 10, 10] },
    { id: '12R', subtype: 'Link', rect: [0, 0, 10, 10], dest: { num: 1, gen: 0 } },
    // Malformed rectangles.
    { id: '13R', subtype: 'Link', rect: [0, 0, 10], dest: 'chapter-two' },
    { id: '14R', subtype: 'Link', rect: [0, 0, Number.NaN, 10], dest: 'chapter-two' },
    { id: '15R', subtype: 'Link', rect: [0, 0, Number.POSITIVE_INFINITY, 10], dest: 'chapter-two' },
    { id: '16R', subtype: 'Link', rect: null, dest: 'chapter-two' },
    null,
    'not-an-annotation'
  ]

  it('keeps only internally targeted link annotations', () => {
    const collected = collectInternalLinks(links)
    expect(collected.map(link => link.id)).toEqual(['5R', '6R', '7R'])
    expect(collected[0]).toEqual({
      id: '5R',
      rect: [72, 640, 320, 672],
      destination: [{ num: 14, gen: 0 }, { name: 'XYZ' }, 0, 792, 0]
    })
    expect(collected[1].destination).toBe('chapter-two')
    expect(collected[2].destination).toBe('missing-chapter')
  })

  it('generates a stable fallback id when the annotation has none', () => {
    const collected = collectInternalLinks([
      { subtype: 'Link', rect: [1, 2, 3, 4], dest: 'chapter-two' },
      { subtype: 'Link', rect: [5, 6, 7, 8], dest: 'chapter-two' }
    ])
    expect(collected.map(link => link.id)).toEqual(['link-0', 'link-1'])
  })

  it('returns an empty list for non-array or empty input', () => {
    expect(collectInternalLinks([])).toEqual([])
    expect(collectInternalLinks(undefined as unknown as unknown[])).toEqual([])
  })
})

describe('rectToNormalizedBox: viewport geometry', () => {
  it('converts a PDF rect using a normal, bottom-left-origin viewport', () => {
    const vp = viewport(612, 792, (x, y) => [x, 792 - y])
    const box = rectToNormalizedBox([72, 640, 320, 672], vp)
    expect(box.left).toBeCloseTo(72 / 612, 10)
    expect(box.top).toBeCloseTo((792 - 672) / 792, 10)
    expect(box.width).toBeCloseTo(248 / 612, 10)
    expect(box.height).toBeCloseTo(32 / 792, 10)
  })

  it('normalizes swapped corners with min/abs so order does not matter', () => {
    const vp = viewport(400, 400, (x, y) => [x, y])
    const box = rectToNormalizedBox([300, 320, 100, 120], vp)
    expect(box).toEqual({ left: 0.25, top: 0.3, width: 0.5, height: 0.5 })
    expect(rectToNormalizedBox([100, 120, 300, 320], vp)).toEqual(box)
  })

  it('handles a rotated viewport where the axes swap', () => {
    // Simulated 90-degree rotation: user-space (x, y) maps to viewport (y, x).
    const vp = viewport(792, 612, (x, y) => [y, x])
    const box = rectToNormalizedBox([72, 640, 320, 672], vp)
    expect(box.left).toBeCloseTo(640 / 792, 10)
    expect(box.top).toBeCloseTo(72 / 612, 10)
    expect(box.width).toBeCloseTo(32 / 792, 10)
    expect(box.height).toBeCloseTo(248 / 612, 10)
  })

  it('keeps normalized placement invariant across zoom scales', () => {
    const rect = [72, 640, 320, 672] as const
    const atScaleOne = rectToNormalizedBox(rect, viewport(612, 792, (x, y) => [x, 792 - y]))
    const atScaleTwo = rectToNormalizedBox(rect, viewport(1224, 1584, (x, y) => [x * 2, (792 - y) * 2]))
    expect(atScaleTwo.left).toBeCloseTo(atScaleOne.left, 10)
    expect(atScaleTwo.top).toBeCloseTo(atScaleOne.top, 10)
    expect(atScaleTwo.width).toBeCloseTo(atScaleOne.width, 10)
    expect(atScaleTwo.height).toBeCloseTo(atScaleOne.height, 10)
  })

  it('guards against a zero-sized viewport', () => {
    const box = rectToNormalizedBox([0, 0, 10, 10], viewport(0, 0, (x, y) => [x, y]))
    expect(box).toEqual({ left: 0, top: 0, width: 0, height: 0 })
  })
})
