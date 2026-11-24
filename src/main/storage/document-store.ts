import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DocumentRecord, RecentDocument, UnderlineAnnotation } from '../../shared/contracts.js'

const RECENT_LIMIT = 12

export function documentId(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class DocumentStore {
  private queue = Promise.resolve()

  constructor(private readonly path: string) {}

  async get(id: string): Promise<DocumentRecord> {
    await this.queue
    const data = await this.read()
    return data[id] ?? { page: 1, annotations: [] }
  }

  remember(id: string, name: string, path: string): Promise<void> {
    return this.mutate(data => {
      data[id] = { ...(data[id] ?? { page: 1, annotations: [] }), name, path, lastOpenedAt: Date.now() }
    })
  }

  async listRecent(): Promise<RecentDocument[]> {
    await this.queue
    const data = await this.read()
    return Object.entries(data)
      .filter(([, record]) => typeof record.name === 'string' && typeof record.path === 'string' && typeof record.lastOpenedAt === 'number')
      .sort(([, left], [, right]) => right.lastOpenedAt! - left.lastOpenedAt!)
      .slice(0, RECENT_LIMIT)
      .map(([id, record]) => ({ id, name: record.name!, lastOpenedAt: record.lastOpenedAt! }))
  }

  savePage(id: string, page: number): Promise<void> {
    return this.mutate(data => {
      data[id] = { ...(data[id] ?? { annotations: [] }), page: Math.max(1, Math.floor(page)) }
    })
  }

  saveAnnotation(id: string, annotation: UnderlineAnnotation): Promise<void> {
    return this.mutate(data => {
      const record = data[id] ?? { page: 1, annotations: [] }
      data[id] = { ...record, annotations: [...record.annotations.filter(item => item.id !== annotation.id), annotation] }
    })
  }

  deleteAnnotation(id: string, annotationId: string): Promise<void> {
    return this.mutate(data => {
      const record = data[id]
      if (record) record.annotations = record.annotations.filter(item => item.id !== annotationId)
    })
  }

  private mutate(operation: (data: Record<string, DocumentRecord>) => void): Promise<void> {
    const pending = this.queue.then(async () => {
      const data = await this.read()
      operation(data)
      await this.write(data)
    })
    this.queue = pending.catch(() => undefined)
    return pending
  }

  private async read(): Promise<Record<string, DocumentRecord>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, DocumentRecord>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('The local document store is unreadable; it was left unchanged.')
    }
  }

  private async write(data: Record<string, DocumentRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 })
    await rename(temporary, this.path)
  }
}
