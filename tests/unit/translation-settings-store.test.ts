import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TranslationSettingsStore } from '../../src/main/translation/settings-store'

let directory = ''
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = '' })

async function store() {
  directory = await mkdtemp(join(tmpdir(), 'mimosa-settings-'))
  return { settings: new TranslationSettingsStore(join(directory, 'llm-settings.json')), path: join(directory, 'llm-settings.json') }
}

describe('TranslationSettingsStore', () => {
  it('loads persisted settings from a cold cache', async () => {
    const { settings, path } = await store()
    const saved = { endpoint: 'https://api.example.test/v1/', model: 'model-x' }
    await writeFile(path, JSON.stringify(saved))
    await expect(settings.get()).resolves.toEqual(saved)
  })

  it('returns null for missing or malformed settings', async () => {
    const { settings, path } = await store()
    await expect(settings.get()).resolves.toBeNull()
    await writeFile(path, '{invalid')
    await expect(new TranslationSettingsStore(path).get()).resolves.toBeNull()
  })

  it('persists and clears settings', async () => {
    const { settings, path } = await store()
    const saved = { endpoint: 'https://api.example.test/v1/', model: 'model-x' }
    await settings.save(saved)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)
    await settings.clear()
    await expect(settings.get()).resolves.toBeNull()
  })
})
