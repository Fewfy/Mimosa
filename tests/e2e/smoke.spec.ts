import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { createUserDataDirectory, launchIsolatedApp, removeUserDataDirectory } from './helpers.js'

test('uses saved translation settings after restarting without opening Settings', async () => {
  const userData = await createUserDataDirectory()
  let requestCount = 0
  const provider = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requestCount++
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: 'Restarted translation works.' } }] }))
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('Mock translation provider failed to bind')
  const endpoint = `http://127.0.0.1:${address.port}/v1/`
  try {
    const firstApp = await launchIsolatedApp(userData)
    try {
      const window = await firstApp.firstWindow()
      await expect(window.getByRole('button', { name: /open a pdf/i })).toBeVisible()
      await window.getByRole('button', { name: 'Settings' }).click()
      await window.getByLabel('API endpoint').fill(endpoint)
      await window.getByLabel('Model').fill('restart-test-model')
      await window.getByLabel('API key').fill('restart-test-key')
      await window.getByRole('button', { name: 'Save securely' }).click()
      await expect(window.getByRole('status')).toContainText('Translation settings saved securely.')
    } finally { await firstApp.close() }

    const secondApp = await launchIsolatedApp(userData)
    try {
      const window = await secondApp.firstWindow()
      await expect(window.getByRole('button', { name: /open a pdf/i })).toBeVisible()
      const result = await window.evaluate(async () => window.mimosa.translate('Persisted settings after restart', 'zh'))
      expect(result).toBe('Restarted translation works.')
      expect(requestCount).toBe(1)
    } finally { await secondApp.close() }
  } finally {
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()))
    await removeUserDataDirectory(userData)
  }
})

test('launches the Mimosa desktop shell and opens settings', async () => {
  const userData = await createUserDataDirectory()
  try {
    const app = await launchIsolatedApp(userData)
    try {
      const window = await app.firstWindow()
      window.on('console', message => console.log('renderer-console:', message.type(), message.text()))
      window.on('pageerror', error => console.log('renderer-error:', error.stack))
      window.on('requestfailed', request => console.log('renderer-request-failed:', request.url(), request.failure()?.errorText))
      window.on('domcontentloaded', () => console.log('renderer-url:', window.url()))
      await expect(window.getByRole('button', { name: /open a pdf/i })).toBeVisible()
      await window.getByRole('button', { name: 'Settings' }).click()
      await expect(window.getByRole('heading', { name: 'Translation settings' })).toBeVisible()
      await expect(window.getByLabel('API key')).toHaveAttribute('type', 'password')
    } finally { await app.close() }
  } finally { await removeUserDataDirectory(userData) }
})
