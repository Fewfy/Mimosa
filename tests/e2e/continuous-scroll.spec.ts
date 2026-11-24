import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createUserDataDirectory, launchIsolatedApp, removeUserDataDirectory } from './helpers.js'
import { createContinuousScrollPdf, SHORT_FIXTURE_PAGE_SIZES, type PdfFixture } from './pdf-fixture.js'

/**
 * DOM contract exercised by these tests (agreed with the renderer work):
 *   .reader                 native scroll container
 *   [data-page]             one wrapper per page, seamless vertical stack
 *   [data-page] .text-layer per-page PDF.js text layer
 *   .underline-mark         page-local underline overlay
 *   .search-hit             lazy search highlight span
 *   aria labels             "Previous page", "Next page", "Page number",
 *                           "Zoom in", "Zoom out", "Search document"
 *   .zoom-value             current zoom percentage readout
 */

type AppFixtures = { pdf: PdfFixture; shortPdf: PdfFixture; userData: string }

const test = base.extend<AppFixtures>({
  pdf: async ({}, use) => {
    const pdf = await createContinuousScrollPdf()
    await use(pdf)
    await rm(pdf.directory, { recursive: true, force: true })
  },
  shortPdf: async ({}, use) => {
    const pdf = await createContinuousScrollPdf(SHORT_FIXTURE_PAGE_SIZES)
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
const SCALE = 1.15

let launchedApps: ElectronApplication[] = []
test.beforeEach(() => { launchedApps = [] })
test.afterEach(async () => {
  for (const app of launchedApps.splice(0)) await app.close().catch(() => undefined)
})

type StackMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  pages: { page: number; top: number; height: number; width: number; bottom: number }[]
}

async function stubOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [target] })
    })
  }, filePath)
}

async function launch(userData: string, pdf: PdfFixture): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await launchIsolatedApp(userData)
  launchedApps.push(app)
  const window = await app.firstWindow()
  await expect(window.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible()
  await stubOpenDialog(app, pdf.path)
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

async function openPdf(window: Page, pdf: PdfFixture): Promise<void> {
  await window.getByRole('button', { name: 'Open PDF', exact: true }).click()
  await expect(window.locator(READER)).toBeVisible()
  await expect(window.locator(PAGE)).toHaveCount(pdf.pageSizes.length)
  await waitForStack(window)
}

async function readMetrics(window: Page): Promise<StackMetrics> {
  return window.evaluate(() => {
    const reader = document.querySelector('.reader') as HTMLElement
    const readerRect = reader.getBoundingClientRect()
    const pages = [...document.querySelectorAll<HTMLElement>('[data-page]')].map((element) => {
      const rect = element.getBoundingClientRect()
      const top = rect.top - readerRect.top + reader.scrollTop
      return { page: Number(element.dataset.page), top, height: rect.height, width: rect.width, bottom: top + rect.height }
    })
    return { scrollTop: reader.scrollTop, scrollHeight: reader.scrollHeight, clientHeight: reader.clientHeight, pages }
  })
}

async function waitForScrollSettled(window: Page): Promise<void> {
  // Wait inside the page for consecutive animation frames with a stable
  // scroll offset. This absorbs layout/scroll-anchoring work without sleeps
  // and cannot hang the test if the renderer keeps adjusting by subpixels.
  await window.evaluate(() => new Promise<void>((resolve) => {
    const reader = document.querySelector('.reader') as HTMLElement
    let previous = Number.NaN
    let stable = 0
    let frames = 0
    const step = () => {
      const current = reader.scrollTop
      stable = Math.abs(current - previous) < 0.01 ? stable + 1 : 0
      previous = current
      frames += 1
      if (stable >= 2 || frames >= 180) { resolve(); return }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }))
}

async function scrollTo(window: Page, target: { page: number; fraction?: number } | { offset: number }): Promise<void> {
  await window.evaluate((value) => {
    const reader = document.querySelector('.reader') as HTMLElement
    if ('offset' in value) { reader.scrollTop = value.offset; return }
    const page = document.querySelector<HTMLElement>(`[data-page="${value.page}"]`)
    if (!page) throw new Error(`page ${value.page} is not rendered`)
    const readerRect = reader.getBoundingClientRect()
    const pageRect = page.getBoundingClientRect()
    reader.scrollTop = pageRect.top - readerRect.top + reader.scrollTop + pageRect.height * (value.fraction ?? 0)
  }, target)
  await waitForScrollSettled(window)
}

async function expectActivePage(window: Page, page: number): Promise<void> {
  await expect(window.getByLabel('Page number')).toHaveValue(String(page))
}

async function readingAnchor(window: Page): Promise<{ page: number; fraction: number; metrics: StackMetrics }> {
  const metrics = await readMetrics(window)
  let owner = metrics.pages[0]
  for (const page of metrics.pages) {
    if (page.top <= metrics.scrollTop + 0.5) owner = page
    else break
  }
  const fraction = owner && owner.height > 0 ? (metrics.scrollTop - owner.top) / owner.height : 0
  return { page: owner?.page ?? 0, fraction, metrics }
}

async function textLayerTexts(window: Page, page: number): Promise<string[]> {
  return window.evaluate((pageNumber) => {
    const layer = document.querySelector(`[data-page="${pageNumber}"] .text-layer`)
    return layer ? [...layer.querySelectorAll('span')].map(span => span.textContent ?? '') : []
  }, page)
}

async function waitForTextStable(window: Page, page: number): Promise<string[]> {
  let previous = Number.NaN
  let stable = 0
  await expect.poll(async () => {
    const count = (await textLayerTexts(window, page)).length
    stable = count === previous && count > 0 ? stable + 1 : 0
    previous = count
    return stable
  }, { timeout: 10000 }).toBeGreaterThanOrEqual(2)
  return textLayerTexts(window, page)
}

async function selectText(window: Page, fromPage: number, fromSpan: number, toPage: number, toSpan: number): Promise<void> {
  await window.evaluate((selection) => {
    const fromLayer = document.querySelector(`[data-page="${selection.fromPage}"] .text-layer`)
    const toLayer = document.querySelector(`[data-page="${selection.toPage}"] .text-layer`)
    const from = fromLayer?.querySelectorAll('span')[selection.fromSpan]
    const to = toLayer?.querySelectorAll('span')[selection.toSpan]
    if (!from?.firstChild || !to?.firstChild) throw new Error('text layer spans are not rendered yet')
    const range = document.createRange()
    range.setStart(from.firstChild, 0)
    range.setEnd(to.firstChild, (to.firstChild as Text).length)
    const rangeSelection = window.getSelection()
    if (!rangeSelection) throw new Error('no selection available')
    rangeSelection.removeAllRanges()
    rangeSelection.addRange(range)
    document.querySelector('.reader')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, { fromPage, fromSpan, toPage, toSpan })
}

async function savedPage(userData: string): Promise<number | null> {
  try {
    const data = JSON.parse(await readFile(join(userData, 'documents.json'), 'utf8')) as Record<string, { page: number }>
    const records = Object.values(data)
    return records.length === 1 ? records[0].page : null
  } catch {
    return null
  }
}

test('renders a seamless mixed-height native page stack', async ({ pdf, userData }) => {
  const { window } = await launch(userData, pdf)
  await openPdf(window, pdf)

  const metrics = await readMetrics(window)
  expect(metrics.pages.map(page => page.page)).toEqual([1, 2, 3, 4, 5])
  expect(metrics.pages.map(page => Math.round(page.height)).length).toBe(new Set(metrics.pages.map(page => Math.round(page.height))).size)
  metrics.pages.forEach((box, index) => {
    const size = pdf.pageSizes[index]
    expect(box.width).toBeCloseTo(size.width * SCALE, 0)
    expect(box.height).toBeCloseTo(size.height * SCALE, 0)
  })

  // Zero inter-page gap and no page chrome: wrappers are a seamless stack.
  expect(Math.abs(metrics.pages[0].top)).toBeLessThanOrEqual(1)
  for (let index = 1; index < metrics.pages.length; index += 1) {
    expect(Math.abs(metrics.pages[index].top - metrics.pages[index - 1].bottom)).toBeLessThanOrEqual(0.5)
  }
  const chrome = await window.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-page]')].map((element) => {
    const style = getComputedStyle(element)
    return {
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
      borderTopWidth: style.borderTopWidth,
      borderBottomWidth: style.borderBottomWidth,
      boxShadow: style.boxShadow
    }
  }))
  for (const style of chrome) {
    for (const value of [style.marginTop, style.marginBottom, style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth]) {
      expect(value).toBe('0px')
    }
    expect(style.boxShadow).toBe('none')
  }

  // The tall final page reaches a normal bottom: no extra space below it.
  await scrollTo(window, { offset: metrics.scrollHeight })
  const bottom = await readMetrics(window)
  const lastPage = bottom.pages[bottom.pages.length - 1]
  expect(lastPage.height).toBeGreaterThan(bottom.clientHeight)
  expect(Math.abs(bottom.scrollTop + bottom.clientHeight - lastPage.bottom)).toBeLessThanOrEqual(2)
  const bottomMarker = window.locator('[data-page="5"] .text-layer span').filter({ hasText: 'BOTTOM MARKER PAGE 5' })
  await expect(bottomMarker).toHaveCount(1)
  const markerBox = await bottomMarker.boundingBox()
  const readerBox = await window.locator(READER).boundingBox()
  expect(markerBox).not.toBeNull()
  expect(readerBox).not.toBeNull()
  expect(markerBox!.y + markerBox!.height).toBeGreaterThan(readerBox!.y)
  expect(markerBox!.y + markerBox!.height).toBeLessThanOrEqual(readerBox!.y + readerBox!.height + 1)
})

test('wheel scrolling is continuous and does not snap to page boundaries', async ({ pdf, userData }) => {
  const { window } = await launch(userData, pdf)
  await openPdf(window, pdf)

  const initial = await readMetrics(window)
  const boundary = initial.pages[1].top
  await scrollTo(window, { offset: boundary - 40 })
  await expectActivePage(window, 1)

  const readerBox = await window.locator(READER).boundingBox()
  expect(readerBox).not.toBeNull()
  await window.mouse.move(readerBox!.x + readerBox!.width / 2, readerBox!.y + readerBox!.height / 2)
  await window.mouse.wheel(0, 120)

  await expect.poll(async () => (await readMetrics(window)).scrollTop).toBeGreaterThan(boundary)
  await waitForScrollSettled(window)
  await expectActivePage(window, 2)

  const scrolled = await readMetrics(window)
  expect(scrolled.scrollTop).toBeGreaterThan(boundary)
  expect(scrolled.scrollTop).toBeLessThan(boundary + initial.pages[1].height)
  // A snapped page turn would land exactly on the page-2 top (or reset to 0).
  expect(Math.abs(scrolled.scrollTop - boundary)).toBeGreaterThan(1)
})

test('commits page-number drafts on Enter and blur and navigates with buttons', async ({ pdf, userData }) => {
  const { window } = await launch(userData, pdf)
  await openPdf(window, pdf)

  const input = window.getByLabel('Page number')
  const previous = window.getByRole('button', { name: 'Previous page' })
  const next = window.getByRole('button', { name: 'Next page' })
  await expect(input).toHaveValue('1')
  await expect(previous).toBeDisabled()

  await next.click()
  await next.click()
  await expect(input).toHaveValue('3')
  await waitForScrollSettled(window)
  const atThree = await readMetrics(window)
  expect(Math.abs(atThree.scrollTop - atThree.pages[2].top)).toBeLessThanOrEqual(2)

  await previous.click()
  await expect(input).toHaveValue('2')
  await waitForScrollSettled(window)
  const atTwo = await readMetrics(window)
  expect(Math.abs(atTwo.scrollTop - atTwo.pages[1].top)).toBeLessThanOrEqual(2)

  // Multi-digit drafts stay editable and do not jump on each typed digit.
  await input.click()
  await input.fill('')
  const beforeDraft = await readMetrics(window)
  await input.pressSequentially('12')
  await expect(input).toHaveValue('12')
  const duringDraft = await readMetrics(window)
  expect(Math.abs(duringDraft.scrollTop - beforeDraft.scrollTop)).toBeLessThanOrEqual(1)

  // Enter clamps the committed page and scrolls to it.
  await input.press('Enter')
  await expect(input).toHaveValue('5')
  await waitForScrollSettled(window)
  const clamped = await readMetrics(window)
  expect(Math.abs(clamped.scrollTop - clamped.pages[4].top)).toBeLessThanOrEqual(2)
  await expect(next).toBeDisabled()

  // Blur commits the draft as well.
  await input.click()
  await input.fill('3')
  await window.locator('.brand').click()
  await expect(input).toHaveValue('3')
  await waitForScrollSettled(window)
  const afterBlur = await readMetrics(window)
  expect(Math.abs(afterBlur.scrollTop - afterBlur.pages[2].top)).toBeLessThanOrEqual(2)
})

test('zoom keeps the same reading anchor', async ({ pdf, userData }) => {
  const { window } = await launch(userData, pdf)
  await openPdf(window, pdf)

  await scrollTo(window, { page: 2, fraction: 0.45 })
  await expectActivePage(window, 2)
  const before = await readingAnchor(window)
  expect(before.page).toBe(2)
  expect(before.fraction).toBeCloseTo(0.45, 1)
  const heightBefore = before.metrics.pages[1].height

  await window.getByRole('button', { name: 'Zoom in' }).click()
  await expect(window.locator('.zoom-value')).toHaveText('130%')
  await expect.poll(async () => (await readMetrics(window)).pages[1].height).toBeGreaterThan(heightBefore)
  await expect.poll(async () => {
    const anchor = await readingAnchor(window)
    return anchor.page === 2 ? Math.abs(anchor.fraction - 0.45) : 1
  }).toBeLessThan(0.05)
  await expectActivePage(window, 2)

  await window.getByRole('button', { name: 'Zoom out' }).click()
  await expect(window.locator('.zoom-value')).toHaveText('115%')
  await expect.poll(async () => {
    const anchor = await readingAnchor(window)
    return anchor.page === 2 ? Math.abs(anchor.fraction - 0.45) : 1
  }).toBeLessThan(0.05)
  await expectActivePage(window, 2)
})

test('restores the saved page after restart without resetting it from page one', async ({ pdf, userData }) => {
  const first = await launch(userData, pdf)
  await openPdf(first.window, pdf)
  const input = first.window.getByLabel('Page number')
  await input.click()
  await input.fill('4')
  await input.press('Enter')
  await expect(input).toHaveValue('4')
  await expect.poll(() => savedPage(userData)).toBe(4)
  await closeApp(first.app)

  const second = await launch(userData, pdf)
  await openPdf(second.window, pdf)
  await expect(second.window.getByLabel('Page number')).toHaveValue('4')
  await waitForScrollSettled(second.window)
  const restored = await readMetrics(second.window)
  expect(Math.abs(restored.scrollTop - restored.pages[3].top)).toBeLessThanOrEqual(2)

  // Force another deterministic render pass, then confirm page one never
  // overwrote the restored position while the stack was being laid out.
  await second.window.getByRole('button', { name: 'Zoom in' }).click()
  await expect(second.window.locator('.zoom-value')).toHaveText('130%')
  expect(await savedPage(userData)).toBe(4)
})

// Regression: at 60% the 1020pt final page is shorter than the reader
// viewport. Without stack padding below the last page, the browser clamps
// scrollTop to the previous page, the observed state reports page 4, and the
// saved position regresses. The stack must pad below the final page so its top
// is reachable and the active page stays 5.
test('jumps to the final short page at 60% zoom and restores it after restart', async ({ pdf, userData }) => {
  const first = await launch(userData, pdf)
  await openPdf(first.window, pdf)
  const zoomValue = first.window.locator('.zoom-value')
  const zoomOut = first.window.getByRole('button', { name: 'Zoom out' })
  for (const expected of ['100%', '85%', '70%', '60%']) {
    await zoomOut.click()
    await expect(zoomValue).toHaveText(expected)
  }
  await expect.poll(async () => Math.round((await readMetrics(first.window)).pages[4].height)).toBe(612)

  const lowZoom = await readMetrics(first.window)
  // Precondition that makes this a regression: last page shorter than viewport.
  expect(lowZoom.clientHeight).toBeGreaterThan(lowZoom.pages[4].height)

  const input = first.window.getByLabel('Page number')
  await input.click()
  await input.fill('5')
  await input.press('Enter')
  await expect(input).toHaveValue('5')
  await expect(first.window.locator(READER)).toHaveAttribute('data-active-page', '5')
  await waitForScrollSettled(first.window)
  const jumped = await readMetrics(first.window)
  expect(Math.abs(jumped.scrollTop - jumped.pages[4].top)).toBeLessThanOrEqual(2)
  await expect.poll(() => savedPage(userData)).toBe(5)
  await closeApp(first.app)

  // The same profile reopens at the default scale; page 5 must still restore.
  const second = await launch(userData, pdf)
  await openPdf(second.window, pdf)
  await expect(second.window.locator('.zoom-value')).toHaveText('115%')
  await expect(second.window.getByLabel('Page number')).toHaveValue('5')
  await expect(second.window.locator(READER)).toHaveAttribute('data-active-page', '5')
  await waitForScrollSettled(second.window)
  const restored = await readMetrics(second.window)
  expect(Math.abs(restored.scrollTop - restored.pages[4].top)).toBeLessThanOrEqual(2)
  expect(await savedPage(userData)).toBe(5)
})

test('jumps to the final page when the whole document is shorter than the viewport', async ({ shortPdf, userData }) => {
  const { window } = await launch(userData, shortPdf)
  await openPdf(window, shortPdf)

  const initial = await readMetrics(window)
  expect(initial.pages).toHaveLength(2)
  expect(initial.clientHeight).toBeGreaterThan(initial.pages[1].height)
  expect(initial.clientHeight).toBeGreaterThan(initial.pages[0].top + initial.pages[0].height + initial.pages[1].height)

  const input = window.getByLabel('Page number')
  await input.click()
  await input.fill('2')
  await input.press('Enter')
  await expect(input).toHaveValue('2')
  await expect(window.locator(READER)).toHaveAttribute('data-active-page', '2')
  await waitForScrollSettled(window)
  const jumped = await readMetrics(window)
  expect(Math.abs(jumped.scrollTop - jumped.pages[1].top)).toBeLessThanOrEqual(2)
  await expect.poll(() => savedPage(userData)).toBe(2)
})

test('keeps underlines page-local, rejects cross-page selections, and persists them', async ({ pdf, userData }) => {
  const first = await launch(userData, pdf)
  await openPdf(first.window, pdf)
  await scrollTo(first.window, { page: 2 })
  await expectActivePage(first.window, 2)
  await waitForTextStable(first.window, 1)
  await waitForTextStable(first.window, 2)

  const underline = first.window.getByRole('button', { name: 'Underline', exact: true })
  await selectText(first.window, 2, 0, 2, 0)
  await expect(underline).toBeVisible()
  await underline.click()
  await expect(first.window.getByRole('status')).toContainText('Underline saved.')
  await expect(first.window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)
  await expect(first.window.locator('[data-page="1"] .underline-mark')).toHaveCount(0)

  // A selection spanning two pages is rejected explicitly and adds nothing.
  await selectText(first.window, 1, 0, 2, 0)
  await expect(underline).toBeVisible()
  await underline.click()
  await expect(first.window.getByRole('status')).toContainText('Select text within a single page to underline.')
  await expect(first.window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)
  await expect(first.window.locator('[data-page="1"] .underline-mark')).toHaveCount(0)
  await closeApp(first.app)

  const second = await launch(userData, pdf)
  await openPdf(second.window, pdf)
  await expect(second.window.locator('.underline-mark')).toHaveCount(1)
  await expect(second.window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)
  await expect(second.window.locator('[data-page="1"] .underline-mark')).toHaveCount(0)
})

test('search highlights a page only when its lazy text layer renders', async ({ pdf, userData }) => {
  const { window } = await launch(userData, pdf)
  await openPdf(window, pdf)

  const lazyPage = window.locator('[data-page="5"]')
  await expect(lazyPage.locator('.text-layer span')).toHaveCount(0)
  await window.getByLabel('Search document').fill(pdf.searchMarker)
  await expect(window.locator('[data-page="1"] .search-hit')).toHaveCount(0)

  const input = window.getByLabel('Page number')
  await input.click()
  await input.fill('5')
  await input.press('Enter')
  await expectActivePage(window, 5)
  await waitForTextStable(window, 5)

  const hits = lazyPage.locator('.text-layer .search-hit')
  await expect.poll(() => hits.count()).toBeGreaterThan(0)
  expect(await hits.count()).toBe(1)
  expect(((await hits.first().textContent()) ?? '').toLowerCase()).toContain(pdf.searchMarker)

  await window.getByRole('button', { name: 'Clear search' }).click()
  await expect(lazyPage.locator('.search-hit')).toHaveCount(0)
})

test('revisiting a page outside the render band duplicates no text and keeps underlines working', async ({ pdf, userData }) => {
  const { window } = await launch(userData, pdf)
  await openPdf(window, pdf)

  await scrollTo(window, { page: 2 })
  await expectActivePage(window, 2)
  const initialTexts = await waitForTextStable(window, 2)
  expect(initialTexts.length).toBeGreaterThan(2)

  await selectText(window, 2, 0, 2, 0)
  await window.getByRole('button', { name: 'Underline', exact: true }).click()
  await expect(window.getByRole('status')).toContainText('Underline saved.')
  await expect(window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)

  // Leave the render band entirely, then come back to the same page.
  await scrollTo(window, { page: 5 })
  await waitForTextStable(window, 5)
  await scrollTo(window, { page: 2 })
  await expectActivePage(window, 2)
  await expect.poll(async () => JSON.stringify(await textLayerTexts(window, 2)))
    .toBe(JSON.stringify(initialTexts))
  const revisitedTexts = await textLayerTexts(window, 2)
  expect(revisitedTexts).toHaveLength(initialTexts.length)
  await expect(window.locator('[data-page="2"] .underline-mark')).toHaveCount(1)

  // The re-rendered text layer is still selectable and annotatable.
  await selectText(window, 2, revisitedTexts.length - 1, 2, revisitedTexts.length - 1)
  await window.getByRole('button', { name: 'Underline', exact: true }).click()
  await expect(window.getByRole('status')).toContainText('Underline saved.')
  await expect(window.locator('[data-page="2"] .underline-mark')).toHaveCount(2)
})
