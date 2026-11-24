import { describe, expect, it, vi } from 'vitest'
import { loadOutline, type OutlineNodeLike } from '../../src/renderer/pdf-outline'

type FakeDocument = {
  numPages: number
  getDestination: ReturnType<typeof vi.fn>
  getPageIndex: ReturnType<typeof vi.fn>
}

function fakeDocument(): FakeDocument {
  return {
    numPages: 20,
    getDestination: vi.fn(async (name: string) => name === 'chapter-two' ? [{ num: 8, gen: 0 }] : null),
    getPageIndex: vi.fn(async (ref: { num: number; gen: number }) => ref.num - 1)
  }
}

describe('loadOutline', () => {
  it('resolves nested destinations and preserves URL-only entries as non-navigable', async () => {
    const nodes: OutlineNodeLike[] = [
      {
        title: 'Contents',
        dest: [{ num: 4, gen: 0 }],
        items: [{ title: 'Chapter two', dest: 'chapter-two', items: [] }]
      },
      { title: 'Publisher site', dest: null, url: 'https://example.com', items: [] }
    ]

    await expect(loadOutline(fakeDocument(), nodes)).resolves.toEqual([
      {
        title: 'Contents',
        page: 4,
        bold: false,
        italic: false,
        children: [{ title: 'Chapter two', page: 8, bold: false, italic: false, children: [] }]
      },
      { title: 'Publisher site', page: null, bold: false, italic: false, children: [] }
    ])
  })

  it('keeps malformed destinations visible without making them navigable', async () => {
    const nodes: OutlineNodeLike[] = [{ title: 'Broken', dest: [{ bad: true }], items: [] }]
    await expect(loadOutline(fakeDocument(), nodes)).resolves.toEqual([
      { title: 'Broken', page: null, bold: false, italic: false, children: [] }
    ])
  })

  it('does not discard the outline when one destination lookup fails', async () => {
    const doc = fakeDocument()
    doc.getDestination.mockRejectedValueOnce(new Error('worker unavailable'))
    await expect(loadOutline(doc, [{ title: 'Broken', dest: 'broken', items: [] }])).resolves.toEqual([
      { title: 'Broken', page: null, bold: false, italic: false, children: [] }
    ])
  })
})
