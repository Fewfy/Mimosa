import { app, dialog, ipcMain, safeStorage } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AskPassageInput, OpenRecentResult, TranslationSettings, UnderlineAnnotation } from '../shared/contracts.js'
import { askPassage } from './ai/client.js'
import { Credentials } from './security/credentials.js'
import { openedDocument, readVerifiedDocument } from './storage/document-files.js'
import { documentId, DocumentStore } from './storage/document-store.js'
import { translateText } from './translation/client.js'
import { TranslationSettingsStore } from './translation/settings-store.js'

const PDF_FILTERS = [{ name: 'PDF documents', extensions: ['pdf'] }]

function documentIdInput(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid document identifier.')
  return value
}

function annotationInput(value: unknown): UnderlineAnnotation {
  if (!value || typeof value !== 'object') throw new Error('Invalid underline annotation.')
  const annotation = value as UnderlineAnnotation
  if (typeof annotation.id !== 'string' || !annotation.id) throw new Error('Invalid underline annotation.')
  if (annotation.comment !== undefined && (typeof annotation.comment !== 'string' || annotation.comment.length > 10_000)) throw new Error('Invalid underline comment.')
  if (annotation.conversation !== undefined) {
    const conversation = annotation.conversation
    if (!conversation || typeof conversation !== 'object' || !Array.isArray(conversation.messages) ||
      conversation.messages.length > 200 || !Number.isFinite(conversation.updatedAt)) {
      throw new Error('Invalid AI conversation.')
    }
    for (const message of conversation.messages) {
      if (!message || (message.role !== 'user' && message.role !== 'assistant') ||
        typeof message.content !== 'string' || !message.content || message.content.length > 20_000 ||
        !Number.isFinite(message.at)) {
        throw new Error('Invalid AI conversation message.')
      }
    }
  }
  return annotation
}

const store = new DocumentStore(join(app.getPath('userData'), 'documents.json'))
const credentials = new Credentials(join(app.getPath('userData'), 'llm-key.enc'))
const translationSettings = new TranslationSettingsStore(join(app.getPath('userData'), 'llm-settings.json'))

export function registerIpc(): void {
  ipcMain.handle('pdf:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: PDF_FILTERS })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const bytes = await readFile(path)
    const id = documentId(bytes)
    const name = basename(path) || 'Document.pdf'
    const record = await store.get(id)
    await store.remember(id, name, path)
    return openedDocument(id, name, bytes, record)
  })
  ipcMain.handle('recent:list', () => store.listRecent())
  ipcMain.handle('recent:open', async (_event, rawId: unknown): Promise<OpenRecentResult> => {
    const id = documentIdInput(rawId)
    const record = await store.get(id)
    if (typeof record.name !== 'string' || typeof record.path !== 'string') throw new Error('This document is not in the recent list.')
    const verified = await readVerifiedDocument(id, record.path, path => readFile(path))
    if (verified.status !== 'ok') return { status: verified.status, name: record.name }
    await store.remember(id, record.name, record.path)
    return { status: 'opened', document: openedDocument(id, record.name, verified.bytes, record) }
  })
  ipcMain.handle('recent:locate', async (_event, rawId: unknown): Promise<OpenRecentResult | null> => {
    const id = documentIdInput(rawId)
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: PDF_FILTERS })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const selectedName = basename(path) || 'Document.pdf'
    const record = await store.get(id)
    const verified = await readVerifiedDocument(id, path, candidate => readFile(candidate))
    if (verified.status !== 'ok') return { status: verified.status, name: record.name ?? selectedName }
    await store.remember(id, selectedName, path)
    return { status: 'opened', document: openedDocument(id, selectedName, verified.bytes, record) }
  })
  ipcMain.handle('document:save-page', (_event, id: string, page: number) => store.savePage(id, page))
  ipcMain.handle('document:save-annotation', (_event, id: string, annotation: unknown) => store.saveAnnotation(id, annotationInput(annotation)))
  ipcMain.handle('document:delete-annotation', (_event, id: string, annotationId: string) => store.deleteAnnotation(id, annotationId))
  ipcMain.handle('translation:get-settings', async () => {
    const settings = await translationSettings.get()
    return settings ? { ...settings, configured: Boolean(await credentials.get()) } : null
  })
  ipcMain.handle('translation:set-settings', async (_event, settings: TranslationSettings, key: string) => {
    let endpoint: URL
    try { endpoint = new URL(settings.endpoint) }
    catch { throw new Error('Provide a valid HTTPS endpoint, model, and API key.') }
    if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) || endpoint.username || endpoint.password || !settings.model.trim()) throw new Error('Provide a valid HTTPS endpoint and model.')
    if (key.trim()) await credentials.set(key)
    else if (!(await credentials.get())) throw new Error('An API key is required for translation and Ask AI.')
    await translationSettings.save(settings)
  })
  ipcMain.handle('translation:clear-settings', async () => {
    await credentials.delete()
    await translationSettings.clear()
  })
  ipcMain.handle('translation:translate', async (_event, text: string, target: 'en' | 'zh') => {
    const settings = await translationSettings.get()
    if (!settings) throw new Error('Configure an LLM endpoint, model, and API key in Settings first.')
    const key = await credentials.get()
    if (!key) throw new Error('Configure an LLM API key in Settings first.')
    return translateText(settings.endpoint, settings.model, key, text, target)
  })
  ipcMain.handle('ai:ask', async (_event, input: unknown) => {
    if (!input || typeof input !== 'object' || !Array.isArray((input as AskPassageInput).history)) throw new Error('Invalid AI question.')
    const settings = await translationSettings.get()
    if (!settings) throw new Error('Configure an LLM endpoint, model, and API key in Settings first.')
    const key = await credentials.get()
    if (!key) throw new Error('Configure an LLM API key in Settings first.')
    return askPassage(settings.endpoint, settings.model, key, input as AskPassageInput)
  })
}
