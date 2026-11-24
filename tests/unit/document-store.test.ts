import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentId, DocumentStore } from '../../src/main/storage/document-store'

let directory = ''
afterEach(async () => {
  vi.restoreAllMocks()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

async function store() {
  directory = await mkdtemp(join(tmpdir(), 'mimosa-store-'))
  return { store: new DocumentStore(join(directory, 'documents.json')), path: join(directory, 'documents.json') }
}

describe('DocumentStore', () => {
  it('keeps reading positions and annotations separate by document', async () => {
    const { store: data } = await store()
    const one = documentId(new TextEncoder().encode('one'))
    const two = documentId(new TextEncoder().encode('two'))
    const annotation = { id: 'a', page: 2, text: 'Important', rects: [{ x: .1, y: .2, width: .3, height: .02 }] }
    await data.savePage(one, 4)
    await data.saveAnnotation(one, annotation)
    expect(await data.get(one)).toEqual({ page: 4, annotations: [annotation] })
    expect(await data.get(two)).toEqual({ page: 1, annotations: [] })
  })

  it('does not overwrite an unreadable store', async () => {
    const { store: data, path } = await store()
    const original = '{invalid'
    await (await import('node:fs/promises')).writeFile(path, original)
    await expect(data.get('x')).rejects.toThrow('unreadable')
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('preserves concurrent page and annotation updates', async () => {
    const { store: data } = await store()
    await Promise.all([
      ...Array.from({ length: 20 }, (_, page) => data.savePage('doc', page + 1)),
      ...Array.from({ length: 20 }, (_, index) => data.saveAnnotation('doc', { id: String(index), page: 1, text: String(index), rects: [] }))
    ])
    const result = await data.get('doc')
    expect(result.page).toBeGreaterThanOrEqual(1)
    expect(result.annotations).toHaveLength(20)
  })

  it('deletes only the requested annotation', async () => {
    const { store: data } = await store()
    const id = 'doc'
    await data.saveAnnotation(id, { id: 'a', page: 1, text: 'A', rects: [] })
    await data.saveAnnotation(id, { id: 'b', page: 1, text: 'B', rects: [] })
    await data.deleteAnnotation(id, 'a')
    expect((await data.get(id)).annotations.map(item => item.id)).toEqual(['b'])
  })

  it('keeps legacy records that predate recent-document metadata', async () => {
    const { store: data, path } = await store()
    const legacy = { page: 3, annotations: [{ id: 'old', page: 3, text: 'Old', rects: [] }] }
    await writeFile(path, JSON.stringify({ legacy }))
    expect(await data.get('legacy')).toEqual(legacy)
    expect(await data.listRecent()).toEqual([])
    await data.savePage('legacy', 5)
    await data.saveAnnotation('legacy', { id: 'new', page: 5, text: 'New', rects: [] })
    expect(await data.get('legacy')).toEqual({ page: 5, annotations: [legacy.annotations[0], { id: 'new', page: 5, text: 'New', rects: [] }] })
    expect(await data.listRecent()).toEqual([])
  })

  it('lists remembered documents newest first and persists the metadata', async () => {
    const { store: data, path } = await store()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000)
    await data.remember('a', 'A.pdf', '/tmp/a.pdf')
    now.mockReturnValue(3_000)
    await data.remember('b', 'B.pdf', '/tmp/b.pdf')
    now.mockReturnValue(2_000)
    await data.remember('c', 'C.pdf', '/tmp/c.pdf')
    now.mockRestore()
    expect(await data.listRecent()).toEqual([
      { id: 'b', name: 'B.pdf', lastOpenedAt: 3_000 },
      { id: 'c', name: 'C.pdf', lastOpenedAt: 2_000 },
      { id: 'a', name: 'A.pdf', lastOpenedAt: 1_000 }
    ])
    const reopened = new DocumentStore(path)
    expect(await reopened.listRecent()).toEqual(await data.listRecent())
    expect(await reopened.get('b')).toMatchObject({ name: 'B.pdf', path: '/tmp/b.pdf', lastOpenedAt: 3_000 })
  })

  it('limits the recent list to twelve documents, newest first', async () => {
    const { store: data } = await store()
    const now = vi.spyOn(Date, 'now')
    for (let index = 1; index <= 13; index += 1) {
      now.mockReturnValue(index)
      await data.remember(`doc-${index}`, `${index}.pdf`, `/tmp/${index}.pdf`)
    }
    now.mockRestore()
    const recent = await data.listRecent()
    expect(recent).toHaveLength(12)
    expect(recent[0]).toMatchObject({ id: 'doc-13', lastOpenedAt: 13 })
    expect(recent[11]).toMatchObject({ id: 'doc-2', lastOpenedAt: 2 })
  })

  it('preserves recent metadata across page and annotation writes', async () => {
    const { store: data } = await store()
    const now = vi.spyOn(Date, 'now').mockReturnValue(500)
    await data.remember('doc', 'Doc.pdf', '/tmp/doc.pdf')
    await data.savePage('doc', 7)
    await data.saveAnnotation('doc', { id: 'a', page: 7, text: 'A', rects: [] })
    await data.deleteAnnotation('doc', 'a')
    now.mockRestore()
    expect(await data.get('doc')).toEqual({ page: 7, annotations: [], name: 'Doc.pdf', path: '/tmp/doc.pdf', lastOpenedAt: 500 })
  })

  it('replaces and removes an underline comment', async () => {
    const { store: data } = await store()
    await data.saveAnnotation('doc', { id: 'a', page: 1, text: 'Passage', rects: [], comment: 'First note' })
    expect((await data.get('doc')).annotations[0]).toEqual({ id: 'a', page: 1, text: 'Passage', rects: [], comment: 'First note' })
    await data.saveAnnotation('doc', { id: 'a', page: 1, text: 'Passage', rects: [], comment: 'Second note' })
    expect((await data.get('doc')).annotations[0].comment).toBe('Second note')
    await data.saveAnnotation('doc', { id: 'a', page: 1, text: 'Passage', rects: [] })
    expect((await data.get('doc')).annotations[0].comment).toBeUndefined()
  })
})
