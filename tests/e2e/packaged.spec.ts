import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'

test('packaged app loads the reader and settings bridge', async () => {
  const app = await electron.launch({ executablePath: join(process.cwd(), 'release/mac-arm64/Mimosa.app/Contents/MacOS/Mimosa'), args: [join(process.cwd(), 'release/mac-arm64/Mimosa.app/Contents/Resources/app.asar')] })
  try {
    const window = await app.firstWindow()
    await expect(window.getByRole('button', { name: /open a pdf/i })).toBeVisible()
    await window.getByRole('button', { name: 'Settings' }).click()
    await expect(window.getByRole('heading', { name: 'Translation settings' })).toBeVisible()
  } finally { await app.close() }
})
