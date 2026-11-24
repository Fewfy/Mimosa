import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'

const rendererUrl = 'http://127.0.0.1:5173'

export async function createUserDataDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mimosa-e2e-userdata-'))
}

export async function launchIsolatedApp(userData: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [join(process.cwd(), 'dist-electron/main/index.js'), `--user-data-dir=${userData}`],
    env: { ...process.env, VITE_DEV_SERVER_URL: rendererUrl }
  })
  try {
    const actualUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    expect(realpathSync(actualUserData)).toBe(realpathSync(userData))
    return app
  } catch (error) {
    await app.close()
    throw error
  }
}

export async function removeUserDataDirectory(userData: string): Promise<void> {
  await rm(userData, { recursive: true, force: true })
}
