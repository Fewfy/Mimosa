import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { test as base, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createUserDataDirectory, launchIsolatedApp, removeUserDataDirectory } from './helpers.js'
import { createContinuousScrollPdf, type PdfFixture } from './pdf-fixture.js'

type AppFixtures = { pdf: PdfFixture; userData: string }

const test = base.extend<AppFixtures>({
  pdf: async ({}, use) => {
    const pdf = await createContinuousScrollPdf()
    await use(pdf)
    await rm(pdf.directory, { recursive: true, force: true })
  },
  userData: async ({}, use) => {
    const directory = await createUserDataDirectory()
    await use(directory)
    await removeUserDataDirectory(directory)
  }
})

type StoredMessage = { role: 'user' | 'assistant'; content: string; at: number }
type StoredAnnotation = { id: string; page: number; text: string; conversation?: { messages: StoredMessage[]; updatedAt: number } }
type StoredDocument = { annotations: StoredAnnotation[] }
type ChatBody = { model?: string; messages?: Array<{ role: string; content: string }> }

let launchedApps: ElectronApplication[] = []
test.beforeEach(() => { launchedApps = [] })
test.afterEach(async () => {
  for (const app of launchedApps.splice(0)) await app.close().catch(() => undefined)
})

async function stubOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [target] })
    })
  }, filePath)
}

async function launch(userData: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await launchIsolatedApp(userData)
  launchedApps.push(app)
  const window = await app.firstWindow()
  await expect(window.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible()
  return { app, window }
}

async function closeApp(app: ElectronApplication): Promise<void> {
  const index = launchedApps.indexOf(app)
  if (index >= 0) launchedApps.splice(index, 1)
  await app.close()
}

async function waitForStack(window: Page): Promise<void> {
  await expect.poll(() => window.evaluate(() => {
    const reader = document.querySelector('.reader') as HTMLElement | null
    if (!reader) return false
    const pages = [...document.querySelectorAll<HTMLElement>('[data-page]')]
    return pages.length > 0 &&
      pages.every(page => page.getBoundingClientRect().height > 0) &&
      reader.scrollHeight > reader.clientHeight
  })).toBe(true)
}

async function openPdf(app: ElectronApplication, window: Page, pdf: PdfFixture): Promise<void> {
  await stubOpenDialog(app, pdf.path)
  await window.getByRole('button', { name: 'Open PDF', exact: true }).click()
  await expect(window.locator('.reader')).toBeVisible()
  await expect(window.locator('[data-page]')).toHaveCount(pdf.pageSizes.length)
  await waitForStack(window)
}

async function goToPage(window: Page, page: number): Promise<void> {
  const input = window.getByLabel('Page number')
  await input.click()
  await input.fill(String(page))
  await input.press('Enter')
  await expect(input).toHaveValue(String(page))
}

async function waitForTextStable(window: Page, page: number): Promise<void> {
  let previous = Number.NaN
  let stable = 0
  await expect.poll(async () => {
    const count = await window.evaluate((pageNumber) => {
      const layer = document.querySelector(`[data-page="${pageNumber}"] .text-layer`)
      return layer ? layer.querySelectorAll('span').length : 0
    }, page)
    stable = count === previous && count > 0 ? stable + 1 : 0
    previous = count
    return stable
  }, { timeout: 10000 }).toBeGreaterThanOrEqual(2)
}

async function selectText(window: Page, page: number, span: number): Promise<void> {
  await window.evaluate((selection) => {
    const layer = document.querySelector(`[data-page="${selection.page}"] .text-layer`)
    const node = layer?.querySelectorAll('span')[selection.span]
    if (!node?.firstChild) throw new Error('text layer spans are not rendered yet')
    const range = document.createRange()
    range.setStart(node.firstChild, 0)
    range.setEnd(node.firstChild, (node.firstChild as Text).length)
    const rangeSelection = window.getSelection()
    if (!rangeSelection) throw new Error('no selection available')
    rangeSelection.removeAllRanges()
    rangeSelection.addRange(range)
    document.querySelector('.reader')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, { page, span })
}

function aiPanel(window: Page): Locator {
  return window.getByRole('complementary', { name: 'Ask AI' })
}

async function storedAnnotations(userData: string): Promise<StoredAnnotation[]> {
  try {
    const data = JSON.parse(await readFile(join(userData, 'documents.json'), 'utf8')) as Record<string, StoredDocument>
    return Object.values(data).flatMap(record => record.annotations)
  } catch {
    return []
  }
}

test('asks AI about a selection, restores the saved conversation, and deletes only the conversation', async ({ pdf, userData }) => {
  test.setTimeout(120_000)
  const answer = [
    '## Passage explained',
    'It is the effort of holding several details in mind at once.',
    '**Important** and *useful* with `context`.',
    '- First detail\n- Second detail',
    '1. Read\n2. Reflect',
    '> Keep the context in mind.',
    '```text\n' + 'long-code-'.repeat(60) + '\n```',
    '| Concept | Meaning |\n| --- | --- |\n| Memory | ' + 'wideTable'.repeat(40) + ' |',
    '[Reference](https://example.com/reference)',
    '[Unsafe](javascript:alert%281%29) [Local](file:///tmp/example) [Insecure](http://example.com)',
    '<script>window.markdownExecuted = true</script>',
    '<img src="invalid" onerror="window.markdownExecuted = true">',
    '![Remote image](https://example.com/image.png)'
  ].join('\n\n')
  let lastBody: ChatBody | null = null
  const provider = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    lastBody = JSON.parse(body) as ChatBody
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: answer } }] }))
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('Mock AI provider failed to bind')
  const endpoint = `http://127.0.0.1:${address.port}/v1/`

  try {
    const first = await launch(userData)
    first.window.on('dialog', dialog => void dialog.accept())
    await first.window.evaluate((value) => window.mimosa.setTranslationSettings({ endpoint: value, model: 'ai-test-model' }, 'ai-test-key'), endpoint)
    await openPdf(first.app, first.window, pdf)
    await goToPage(first.window, 2)
    await waitForTextStable(first.window, 2)
    await selectText(first.window, 2, 0)
    await first.window.getByRole('button', { name: 'Ask AI' }).click()

    const panel = aiPanel(first.window)
    await expect(panel).toBeVisible()
    await expect(panel.locator('.ai-quote')).toContainText('MIMOSA PAGE 2')
    await panel.getByLabel('Question about this passage').fill('What does **this passage** mean?')
    await panel.getByRole('button', { name: 'Send' }).click()
    await expect(panel).toContainText('It is the effort of holding several details in mind at once.')
    const assistant = panel.locator('.ai-message.assistant')
    await expect(assistant.getByRole('heading', { name: 'Passage explained', level: 2 })).toBeVisible()
    await expect(assistant.locator('strong')).toHaveText('Important')
    await expect(assistant.locator('em')).toHaveText('useful')
    await expect(assistant.locator('ul li')).toHaveCount(2)
    await expect(assistant.locator('ol li')).toHaveCount(2)
    await expect(assistant.locator('blockquote')).toContainText('Keep the context')
    await expect(assistant.locator('p code')).toHaveText('context')
    await expect(assistant.locator('pre code')).toContainText('long-code-')
    await expect(assistant.locator('table th')).toHaveText(['Concept', 'Meaning'])
    await expect(assistant.locator('a')).toHaveCount(1)
    await expect(assistant.getByRole('link', { name: 'Reference' })).toHaveAttribute('href', 'https://example.com/reference')
    await expect(assistant.locator('a')).toHaveAttribute('target', '_blank')
    await expect(assistant.locator('a')).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(assistant.locator('script, img, iframe')).toHaveCount(0)
    expect(await first.window.evaluate(() => 'markdownExecuted' in window)).toBe(false)
    await expect(panel.locator('.ai-message.user p')).toHaveText('What does **this passage** mean?')
    await expect(panel.locator('.ai-message.user strong')).toHaveCount(0)
    await panel.getByRole('separator', { name: 'Resize AI panel' }).press('Home')
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    expect(await panel.locator('.ai-messages').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    for (const selector of ['pre', 'table']) {
      expect(await assistant.locator(selector).evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
    }
    await expect(first.window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)
    await expect.poll(async () => (await storedAnnotations(userData))[0]?.conversation?.messages.length).toBe(2)

    expect(lastBody?.model).toBe('ai-test-model')
    expect(lastBody?.messages?.[0]?.content).toContain('<PAGE_CONTEXT page="2">')
    expect(lastBody?.messages?.[0]?.content).toContain('Shared underline phrase on every page.')
    expect(lastBody?.messages?.at(-1)).toEqual({ role: 'user', content: 'What does **this passage** mean?' })
    await closeApp(first.app)

    const second = await launch(userData)
    await openPdf(second.app, second.window, pdf)
    await goToPage(second.window, 2)
    await waitForTextStable(second.window, 2)
    await second.window.getByRole('button', { name: 'Edit underline comment' }).click()
    const dialog = second.window.getByRole('dialog', { name: 'Underline comment' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Ask AI' }).click()

    const restored = aiPanel(second.window)
    await expect(restored).toContainText('What does **this passage** mean?')
    await expect(restored).toContainText('It is the effort of holding several details in mind at once.')
    await expect(restored.getByRole('heading', { name: 'Passage explained', level: 2 })).toBeVisible()
    await expect(restored.locator('.ai-message.assistant strong')).toHaveText('Important')
    await restored.getByRole('button', { name: 'Delete conversation' }).click()
    await expect(second.window.getByRole('status')).toContainText('Conversation deleted.')
    await expect(restored.locator('.ai-message')).toHaveCount(0)
    await expect(second.window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)
    await expect.poll(async () => (await storedAnnotations(userData))[0]?.conversation).toBeUndefined()
    await closeApp(second.app)
  } finally {
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()))
  }
})
