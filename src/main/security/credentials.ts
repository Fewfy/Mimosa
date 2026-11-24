import { safeStorage } from 'electron'
import { readFile, unlink, writeFile } from 'node:fs/promises'

export class Credentials {
  constructor(private readonly path: string) {}

  async set(key: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this Mac.')
    await writeFile(this.path, safeStorage.encryptString(key), { mode: 0o600 })
  }

  async get(): Promise<string | null> {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this Mac.')
      return safeStorage.decryptString(await readFile(this.path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async delete(): Promise<void> {
    await unlink(this.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}
