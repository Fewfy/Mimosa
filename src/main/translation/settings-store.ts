import { readFile, unlink, writeFile } from 'node:fs/promises'
import type { TranslationSettings } from '../../shared/contracts.js'

export class TranslationSettingsStore {
  private settings: TranslationSettings | null = null

  constructor(private readonly path: string) {}

  async get(): Promise<TranslationSettings | null> {
    if (this.settings) return this.settings
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as TranslationSettings
      if (typeof parsed.endpoint === 'string' && typeof parsed.model === 'string') this.settings = parsed
    } catch { return null }
    return this.settings
  }

  async save(settings: TranslationSettings): Promise<void> {
    await writeFile(this.path, JSON.stringify(settings), { mode: 0o600 })
    this.settings = settings
  }

  async clear(): Promise<void> {
    await unlink(this.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    this.settings = null
  }
}
