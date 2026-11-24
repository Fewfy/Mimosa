import type { DocumentRecord, OpenedDocument } from '../../shared/contracts.js'
import { documentId } from './document-store.js'

export type ReadBytes = (path: string) => Promise<Uint8Array>
export type VerifiedDocument = { status: 'ok'; bytes: Uint8Array } | { status: 'missing' | 'changed' }

export function openedDocument(id: string, name: string, bytes: Uint8Array, record: Pick<DocumentRecord, 'page' | 'annotations'>): OpenedDocument {
  return {
    id,
    name,
    bytes: Uint8Array.from(bytes).buffer,
    page: record.page,
    annotations: record.annotations
  }
}

export async function readVerifiedDocument(id: string, path: string, readBytes: ReadBytes): Promise<VerifiedDocument> {
  let bytes: Uint8Array
  try {
    bytes = await readBytes(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    throw error
  }
  return documentId(bytes) === id ? { status: 'ok', bytes } : { status: 'changed' }
}
