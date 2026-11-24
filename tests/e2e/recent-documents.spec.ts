import { readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test as base, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createUserDataDirectory, launchIsolatedApp, removeUserDataDirectory } from './helpers.js'
import { createContinuousScrollPdf, SHORT_FIXTURE_PAGE_SIZES, type PdfFixture } from './pdf-fixture.js'

/**
 * DOM contract exercised by these tests (as implemented by the renderer):
 *   "Home" button                                        leaves the reader
 *   heading "Recent documents"                           homepage list
 *   button[aria-label "<filename>"][data-document-id]     recent entry
 *   [data-last-opened-at]                                formatted reopen date
 *   "Locate <filename>" button                           shown for missing/changed
 *   .recent-issue[data-status="missing" | "changed"]      issue row
 *
 * Recent files are ordinary opens performed through the UI. The native open
 * dialog is stubbed with the same technique used by continuous-scroll.spec.ts.
 * documents.json is read only to assert persistence and rejection behavior.
 */

type AppFixtures = { alpha: PdfFixture; bravo: PdfFixture; userData: string }

async function createNamedFixture(
  pageSizes: Parameters<typeof createContinuousScrollPdf>[0],
  filename: string
): Promise<PdfFixture> {
  const pdf = await createContinuousScrollPdf(pageSizes)
  const path = join(pdf.directory, filename)
  await rename(pdf.path, path)
  return { ...pdf, path }
}

const test = base.extend<AppFixtures>({
  alpha: async ({}, use) => {
    const pdf = await createNamedFixture(undefined, 'mimosa-alpha.pdf')
    await use(pdf)
    await rm(pdf.directory, { recursive: true, force: true })
  },
  bravo: async ({}, use) => {
    const pdf = await createNamedFixture(SHORT_FIXTURE_PAGE_SIZES, 'mimosa-bravo.pdf')
    await use(pdf)
    await rm(pdf.directory, { recursive: true, force: true })
  },
  userData: async ({}, use) => {
    const directory = await createUserDataDirectory()
    await use(directory)
    await removeUserDataDirectory(directory)
  }
})

const READER = '.reader'
const PAGE = '[data-page]'
const ALPHA_NAME = 'mimosa-alpha.pdf'
const BRAVO_NAME = 'mimosa-bravo.pdf'

type StoredAnnotation = { id: string; page: number; text: string; comment?: string }
type StoredDocument = { page: number; annotations: StoredAnnotation[]; name?: string; path?: string; lastOpenedAt?: number }

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

async function stubCanceledDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: true, filePaths: [] })
    })
  })
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
  await expect(window.locator(READER)).toBeVisible()
  await expect(window.locator(PAGE)).toHaveCount(pdf.pageSizes.length)
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

async function underlineSelection(window: Page, page: number, span = 0): Promise<void> {
  await waitForTextStable(window, page)
  await selectText(window, page, span)
  const underline = window.getByRole('button', { name: 'Underline' })
  await expect(underline).toBeVisible()
  await underline.click()
  await expect(window.getByRole('status')).toContainText('Underline saved.')
  await expect(window.locator(`[data-page="${page}"] .underline-mark`)).toHaveCount(1)
}

async function clickHome(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Home', exact: true }).click()
  await expect(window.locator(READER)).toHaveCount(0)
  await expect(window.getByRole('heading', { name: 'Recent documents' })).toBeVisible()
}

function recentItem(window: Page, name: string): Locator {
  return window.getByRole('button', { name, exact: true })
}

function locateButton(window: Page, name: string): Locator {
  return window.getByRole('button', { name: `Locate ${name}`, exact: true })
}

async function expectRecent(window: Page, name: string): Promise<Locator> {
  const item = recentItem(window, name)
  await expect(item).toBeVisible()
  await expect(item).toContainText(name)
  await expect(item).toHaveAttribute('data-document-id', /^[a-f0-9]{64}$/)
  const date = item.locator('[data-last-opened-at]')
  await expect(date).toHaveCount(1)
  await expect(date).toHaveAttribute('data-last-opened-at', /^\d+$/)
  return item
}

async function readStore(userData: string): Promise<Record<string, StoredDocument>> {
  try {
    return JSON.parse(await readFile(join(userData, 'documents.json'), 'utf8')) as Record<string, StoredDocument>
  } catch {
    return {}
  }
}

async function storedByName(userData: string, name: string): Promise<StoredDocument | undefined> {
  return Object.values(await readStore(userData)).find(record => record.name === name)
}

test('lists an ordinary open after Home and restart and reopens its page, underline, and comment', async ({ alpha, userData }) => {
  test.setTimeout(90_000)
  const first = await launch(userData)
  await openPdf(first.app, first.window, alpha)
  await goToPage(first.window, 3)
  await underlineSelection(first.window, 3)
  await expect.poll(async () => (await storedByName(userData, ALPHA_NAME))?.page).toBe(3)
  await first.window.getByRole('button', { name: 'Edit underline comment' }).first().click()
  const firstDialog = first.window.getByRole('dialog', { name: 'Underline comment' })
  await firstDialog.getByLabel('Comment').fill('Resume at the important passage')
  await firstDialog.getByRole('button', { name: 'Save comment' }).click()
  await expect(firstDialog).toBeHidden()
  await expect.poll(async () => (await storedByName(userData, ALPHA_NAME))?.annotations[0]?.comment).toBe('Resume at the important passage')

  await clickHome(first.window)
  await expectRecent(first.window, ALPHA_NAME)
  await closeApp(first.app)

  // The homepage remembers the file after a restart without reopening it.
  const second = await launch(userData)
  await expect(second.window.getByRole('heading', { name: 'Recent documents' })).toBeVisible()
  await expectRecent(second.window, ALPHA_NAME)

  await recentItem(second.window, ALPHA_NAME).click()
  await expect(second.window.locator(READER)).toBeVisible()
  await expect(second.window.getByLabel('Page number')).toHaveValue('3')
  await waitForTextStable(second.window, 3)
  await expect(second.window.locator('[data-page="3"] .underline-mark')).toHaveCount(1)
  await second.window.getByRole('button', { name: 'Edit underline comment' }).first().click()
  await expect(second.window.getByRole('dialog', { name: 'Underline comment' }).getByLabel('Comment')).toHaveValue('Resume at the important passage')
  await closeApp(second.app)
})

test('orders recent documents by most recent open', async ({ alpha, bravo, userData }) => {
  test.setTimeout(90_000)
  const { app, window } = await launch(userData)
  await openPdf(app, window, alpha)
  await clickHome(window)
  await expectRecent(window, ALPHA_NAME)
  await expect(recentItem(window, BRAVO_NAME)).toHaveCount(0)

  await openPdf(app, window, bravo)
  await clickHome(window)
  const alphaAfterBravo = await expectRecent(window, ALPHA_NAME)
  const bravoAfterBravo = await expectRecent(window, BRAVO_NAME)
  const bravoBox = await bravoAfterBravo.boundingBox()
  const alphaBox = await alphaAfterBravo.boundingBox()
  expect(bravoBox).not.toBeNull()
  expect(alphaBox).not.toBeNull()
  expect(bravoBox!.y).toBeLessThan(alphaBox!.y)

  // Reopening through the recent list moves that document back to the top.
  await recentItem(window, ALPHA_NAME).click()
  await expect(window.locator(READER)).toBeVisible()
  await clickHome(window)
  const alphaAfterReopen = await expectRecent(window, ALPHA_NAME)
  const bravoAfterReopen = await expectRecent(window, BRAVO_NAME)
  const reopenedAlphaBox = await alphaAfterReopen.boundingBox()
  const remainingBravoBox = await bravoAfterReopen.boundingBox()
  expect(reopenedAlphaBox).not.toBeNull()
  expect(remainingBravoBox).not.toBeNull()
  expect(reopenedAlphaBox!.y).toBeLessThan(remainingBravoBox!.y)
})

test('offers Locate for a missing recent, keeps the list on cancel, rejects another PDF, and opens moved bytes', async ({ alpha, bravo, userData }) => {
  test.setTimeout(150_000)
  const { app, window } = await launch(userData)
  await openPdf(app, window, alpha)
  await goToPage(window, 2)
  await underlineSelection(window, 2)
  await expect.poll(async () => (await storedByName(userData, ALPHA_NAME))?.page).toBe(2)
  await window.getByRole('button', { name: 'Edit underline comment' }).first().click()
  const editor = window.getByRole('dialog', { name: 'Underline comment' })
  await editor.getByLabel('Comment').fill('Location test note')
  await editor.getByRole('button', { name: 'Save comment' }).click()
  await expect(editor).toBeHidden()
  await expect.poll(async () => (await storedByName(userData, ALPHA_NAME))?.annotations[0]?.comment).toBe('Location test note')
  await clickHome(window)
  await expectRecent(window, ALPHA_NAME)

  // The original path disappears but its bytes stay inside the owned fixture
  // directory, so they can be re-selected through Locate.
  const movedPath = join(alpha.directory, 'mimosa-alpha-moved.pdf')
  await rename(alpha.path, movedPath)

  await recentItem(window, ALPHA_NAME).click()
  await expect(window.locator('.recent-issue[data-status="missing"]')).toBeVisible()
  await expect(locateButton(window, ALPHA_NAME)).toBeVisible()
  await expect(window.locator(READER)).toHaveCount(0)

  // Cancelling the native picker leaves the list and issue intact.
  await stubCanceledDialog(app)
  await locateButton(window, ALPHA_NAME).click()
  await expect(window.locator('.recent-issue[data-status="missing"]')).toBeVisible()
  await expectRecent(window, ALPHA_NAME)
  await expect(window.locator(READER)).toHaveCount(0)

  // Choosing an unrelated PDF is reported as changed and applies no annotations.
  await stubOpenDialog(app, bravo.path)
  await locateButton(window, ALPHA_NAME).click()
  await expect(window.locator('.recent-issue[data-status="changed"]')).toBeVisible()
  await expect(window.locator(READER)).toHaveCount(0)
  await expect(window.locator('.underline-mark')).toHaveCount(0)
  const afterRejection = await readStore(userData)
  const alphaAfterRejection = Object.values(afterRejection).find(record => record.name === ALPHA_NAME)
  expect(alphaAfterRejection?.annotations.map(annotation => annotation.comment)).toEqual(['Location test note'])
  expect(Object.values(afterRejection).some(record => record.name === BRAVO_NAME)).toBe(false)

  // Locating the moved original reopens the saved page, underline, and comment.
  await stubOpenDialog(app, movedPath)
  await locateButton(window, ALPHA_NAME).click()
  await expect(window.locator(READER)).toBeVisible()
  await expect(window.getByLabel('Page number')).toHaveValue('2')
  await waitForTextStable(window, 2)
  await expect(window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)
  await window.getByRole('button', { name: 'Edit underline comment' }).first().click()
  await expect(window.getByRole('dialog', { name: 'Underline comment' }).getByLabel('Comment')).toHaveValue('Location test note')
  await closeApp(app)
})
