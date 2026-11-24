import { describe, expect, it } from 'vitest'
import { openedDocument, readVerifiedDocument } from '../../src/main/storage/document-files'
import { documentId } from '../../src/main/storage/document-store'

const bytes = new TextEncoder().encode('%PDF-1.7 test')
const id = documentId(bytes)
const record = {
  page: 4,
  annotations: [{ id: 'a', page: 4, text: 'Passage', rects: [], comment: 'Note' }]
}

describe('document files', () => {
  it('builds opened documents from explicit fields only', () => {
    const document = openedDocument(id, 'Report.pdf', bytes, record)
    expect(document).toEqual({
      id,
      name: 'Report.pdf',
      bytes: expect.any(ArrayBuffer),
      page: 4,
      annotations: record.annotations
    })
    expect(new Uint8Array(document.bytes)).toEqual(bytes)
    expect(document).not.toHaveProperty('path')
  })

  it('returns the bytes when the stored content still matches the document id', async () => {
    const result = await readVerifiedDocument(id, '/tmp/report.pdf', async () => bytes)
    expect(result).toEqual({ status: 'ok', bytes })
  })

  it('reports a missing file when the stored path no longer exists', async () => {
    const error = Object.assign(new Error('gone'), { code: 'ENOENT' })
    const result = await readVerifiedDocument(id, '/tmp/gone.pdf', async () => { throw error })
    expect(result).toEqual({ status: 'missing' })
  })

  it('reports changed content when the hash no longer matches', async () => {
    const result = await readVerifiedDocument(id, '/tmp/report.pdf', async () => new TextEncoder().encode('different'))
    expect(result).toEqual({ status: 'changed' })
  })

  it('propagates filesystem errors other than a missing file', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    await expect(readVerifiedDocument(id, '/tmp/report.pdf', async () => { throw error })).rejects.toBe(error)
  })
})
