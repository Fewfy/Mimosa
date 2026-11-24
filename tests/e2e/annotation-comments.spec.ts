import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test as base, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createUserDataDirectory, launchIsolatedApp, removeUserDataDirectory } from './helpers.js'
import { createContinuousScrollPdf, type PdfFixture } from './pdf-fixture.js'

/**
 * DOM contract exercised by these tests (as implemented by the renderer):
 *   button[aria-label "Edit underline comment"]   one per underline rect
 *   role=dialog named "Underline comment"         comment editor
 *   textarea labeled "Comment"
 *   buttons "Save comment", "Remove comment", "Delete underline", "Cancel"
 *
 * Comments ride on the existing saveAnnotation path. documents.json is read
 * only to assert persistence; every feature action uses the rendered UI.
 */

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

const READER = '.reader'
const PAGE = '[data-page]'
const PDF_NAME = 'continuous-scroll-fixture.pdf'

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

async function waitForTextStable(window: Page, page: number): Promise<string[]> {
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
  return window.evaluate((pageNumber) => {
    const layer = document.querySelector(`[data-page="${pageNumber}"] .text-layer`)
    return layer ? [...layer.querySelectorAll('span')].map(span => span.textContent ?? '') : []
  }, page)
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

function commentDialog(window: Page): Locator {
  return window.getByRole('dialog', { name: 'Underline comment' })
}

async function openCommentDialog(window: Page): Promise<Locator> {
  const edit = window.getByRole('button', { name: 'Edit underline comment' })
  await expect(edit.first()).toBeVisible()
  await edit.first().click()
  const dialog = commentDialog(window)
  await expect(dialog).toBeVisible()
  return dialog
}

async function saveComment(dialog: Locator, comment: string): Promise<void> {
  await dialog.getByLabel('Comment').fill(comment)
  await dialog.getByRole('button', { name: 'Save comment' }).click()
  await expect(dialog).toBeHidden()
}

async function readStore(userData: string): Promise<Record<string, StoredDocument>> {
  try {
    return JSON.parse(await readFile(join(userData, 'documents.json'), 'utf8')) as Record<string, StoredDocument>
  } catch {
    return {}
  }
}

async function storedDocument(userData: string): Promise<StoredDocument | undefined> {
  return Object.values(await readStore(userData)).find(record => record.name === PDF_NAME)
}

async function annotationComments(userData: string): Promise<string[]> {
  const record = await storedDocument(userData)
  return (record?.annotations ?? []).map(annotation => annotation.comment ?? '')
}

async function annotationCount(userData: string): Promise<number> {
  const record = await storedDocument(userData)
  return record?.annotations.length ?? 0
}

async function savedPage(userData: string): Promise<number | null> {
  return (await storedDocument(userData))?.page ?? null
}

test('adds, edits, and cancels an underline comment that survives a restart', async ({ pdf, userData }) => {
  test.setTimeout(90_000)
  const first = await launch(userData)
  await openPdf(first.app, first.window, pdf)
  await goToPage(first.window, 2)
  await underlineSelection(first.window, 2)
  await expect.poll(() => savedPage(userData)).toBe(2)

  const addDialog = await openCommentDialog(first.window)
  await expect(addDialog.getByLabel('Comment')).toHaveValue('')
  await saveComment(addDialog, 'First reading note')
  await expect.poll(() => annotationComments(userData)).toEqual(['First reading note'])

  // Cancelling an edit leaves the previously saved comment untouched.
  const cancelDialog = await openCommentDialog(first.window)
  await expect(cancelDialog.getByLabel('Comment')).toHaveValue('First reading note')
  await cancelDialog.getByLabel('Comment').fill('Discarded edit')
  await cancelDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(commentDialog(first.window)).toBeHidden()
  await expect.poll(() => annotationComments(userData)).toEqual(['First reading note'])

  // Saving an edit replaces the stored comment in place.
  const editDialog = await openCommentDialog(first.window)
  await saveComment(editDialog, 'Reviewed note after scrolling')
  await expect.poll(() => annotationComments(userData)).toEqual(['Reviewed note after scrolling'])
  await closeApp(first.app)

  const second = await launch(userData)
  await openPdf(second.app, second.window, pdf)
  await expect(second.window.getByLabel('Page number')).toHaveValue('2')
  await waitForTextStable(second.window, 2)
  await expect(second.window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)
  const reopenedDialog = await openCommentDialog(second.window)
  await expect(reopenedDialog.getByLabel('Comment')).toHaveValue('Reviewed note after scrolling')
  await expect.poll(() => annotationComments(userData)).toEqual(['Reviewed note after scrolling'])
  await closeApp(second.app)
})

test('removes a comment while keeping the underline, then deletes the underline durably', async ({ pdf, userData }) => {
  test.setTimeout(120_000)
  const first = await launch(userData)
  await openPdf(first.app, first.window, pdf)
  await goToPage(first.window, 2)
  await underlineSelection(first.window, 2)
  await expect.poll(() => savedPage(userData)).toBe(2)
  const addDialog = await openCommentDialog(first.window)
  await saveComment(addDialog, 'Temporary note')
  await expect.poll(() => annotationComments(userData)).toEqual(['Temporary note'])

  const removeDialog = await openCommentDialog(first.window)
  await removeDialog.getByRole('button', { name: 'Remove comment' }).click()
  await expect(commentDialog(first.window)).toBeHidden()
  await expect(first.window.getByRole('status')).toContainText('Comment removed.')
  // Removing the comment must leave the underline and its annotation in place.
  await expect(first.window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)
  await expect.poll(() => annotationComments(userData)).toEqual([''])
  await expect.poll(() => annotationCount(userData)).toBe(1)
  await closeApp(first.app)

  const second = await launch(userData)
  await openPdf(second.app, second.window, pdf)
  await expect(second.window.getByLabel('Page number')).toHaveValue('2')
  await waitForTextStable(second.window, 2)
  await expect(second.window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)
  const reopenDialog = await openCommentDialog(second.window)
  await expect(reopenDialog.getByLabel('Comment')).toHaveValue('')
  await reopenDialog.getByRole('button', { name: 'Delete underline' }).click()
  await expect(commentDialog(second.window)).toBeHidden()
  await expect(second.window.getByRole('status')).toContainText('Underline removed.')
  await expect(second.window.locator('.underline-mark')).toHaveCount(0)
  await expect.poll(() => annotationCount(userData)).toBe(0)
  await closeApp(second.app)

  const third = await launch(userData)
  await openPdf(third.app, third.window, pdf)
  await expect(third.window.getByLabel('Page number')).toHaveValue('2')
  await expect(third.window.locator('.underline-mark')).toHaveCount(0)
  await expect(third.window.getByRole('button', { name: 'Edit underline comment' })).toHaveCount(0)
  await closeApp(third.app)
})
