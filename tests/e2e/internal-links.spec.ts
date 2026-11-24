import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createUserDataDirectory, launchIsolatedApp, removeUserDataDirectory } from './helpers.js'
import {
  createLinkedPdf,
  LINKED_ANNOTATIONS,
  LINKED_PAGE_SIZES,
  type LinkedPdfFixture,
  type PdfRect
} from './linked-pdf-fixture.js'

/**
 * DOM contract exercised by these tests (agreed with the renderer work):
 *   .reader                       native scroll container
 *   [data-page]                   one wrapper per page (page wrappers only)
 *   .pdf-internal-link            transparent <button> over an embedded link
 *   aria-label                    "Go to linked page"
 *   data-link-id                  PDF annotation id for the source link
 *
 * Link buttons carry no destination attribute: the renderer resolves the
 * destination when the button is activated and moves the active page. Invalid
 * destinations keep the button; activating it shows the shared role="status"
 * toast containing "invalid target" and does not move. External URI
 * annotations are skipped entirely (no button, no sidebar).
 */

type AppFixtures = { linkedPdf: LinkedPdfFixture; userData: string }

const test = base.extend<AppFixtures>({
  linkedPdf: async ({}, use) => {
    const pdf = await createLinkedPdf()
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
const LINK = '.pdf-internal-link'
const CONTENTS_LINKS = `[data-page="1"] ${LINK}`

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

type LinkButton = {
  linkId: string | null
  ariaLabel: string | null
  hasPageAttribute: boolean
}

type LinkGeometry = {
  linkId: string
  left: number
  top: number
  width: number
  height: number
  pixelWidth: number
}

function linkSelector(id: string): string {
  return `[data-page="1"] ${LINK}[data-link-id="${id}"]`
}

async function stubOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [target] })
    })
  }, filePath)
}

async function launch(userData: string, pdf: LinkedPdfFixture): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await launchIsolatedApp(userData)
  launchedApps.push(app)
  const window = await app.firstWindow()
  await expect(window.getByRole('button', { name: 'Open PDF', exact: true })).toBeVisible()
  await stubOpenDialog(app, pdf.path)
  return { app, window }
}

async function openPdf(window: Page, pdf: LinkedPdfFixture): Promise<void> {
  await window.getByRole('button', { name: 'Open PDF', exact: true }).click()
  await expect(window.locator(READER)).toBeVisible()
  await expect(window.locator(PAGE)).toHaveCount(pdf.pageSizes.length)
  await expect.poll(() => window.evaluate(() => {
    const reader = document.querySelector('.reader') as HTMLElement | null
    if (!reader) return false
    const pages = [...document.querySelectorAll<HTMLElement>('[data-page]')]
    return pages.length > 0 &&
      pages.every(page => page.getBoundingClientRect().height > 0) &&
      reader.scrollHeight > reader.clientHeight
  })).toBe(true)
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

async function goToPage(window: Page, page: number): Promise<void> {
  const input = window.getByLabel('Page number')
  await input.click()
  await input.fill(String(page))
  await input.press('Enter')
  await expect(input).toHaveValue(String(page))
  await waitForScrollSettled(window)
}

async function expectActivePage(window: Page, page: number): Promise<void> {
  await expect(window.getByLabel('Page number')).toHaveValue(String(page))
  await expect(window.locator(READER)).toHaveAttribute('data-active-page', String(page))
}

async function expectScrolledToPage(window: Page, page: number): Promise<void> {
  await waitForScrollSettled(window)
  const metrics = await readMetrics(window)
  expect(Math.abs(metrics.scrollTop - metrics.pages[page - 1].top)).toBeLessThanOrEqual(2)
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

async function linkButtons(window: Page): Promise<LinkButton[]> {
  return window.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-page="1"] .pdf-internal-link')].map(element => ({
    linkId: element.getAttribute('data-link-id'),
    ariaLabel: element.getAttribute('aria-label'),
    hasPageAttribute: element.hasAttribute('data-page')
  })))
}

async function linkGeometry(window: Page): Promise<LinkGeometry[]> {
  return window.evaluate(() => {
    const page = document.querySelector('[data-page="1"]') as HTMLElement
    const pageRect = page.getBoundingClientRect()
    return [...page.querySelectorAll<HTMLElement>('.pdf-internal-link')].map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        linkId: element.getAttribute('data-link-id') ?? '',
        left: (rect.left - pageRect.left) / pageRect.width,
        top: (rect.top - pageRect.top) / pageRect.height,
        width: rect.width / pageRect.width,
        height: rect.height / pageRect.height,
        pixelWidth: rect.width
      }
    })
  })
}

/** Converts a PDF user-space rect's centre into page-relative fractions. */
function pdfRectCenterFraction(rect: PdfRect, pageSize: { width: number; height: number }): { x: number; y: number } {
  const [x1, y1, x2, y2] = rect
  return {
    x: ((x1 + x2) / 2) / pageSize.width,
    y: (pageSize.height - (y1 + y2) / 2) / pageSize.height
  }
}

test('renders a transparent internal-link button for every internal destination and skips external URIs', async ({ linkedPdf, userData }) => {
  const { window } = await launch(userData, linkedPdf)
  await openPdf(window, linkedPdf)

  const links = window.locator(CONTENTS_LINKS)
  await expect(links).toHaveCount(linkedPdf.expectedInternalLinkCount)

  const buttons = await linkButtons(window)
  expect(buttons).toHaveLength(linkedPdf.expectedInternalLinkCount)
  expect(buttons.every(button => button.ariaLabel === 'Go to linked page')).toBe(true)
  expect(buttons.every(button => (button.linkId ?? '').length > 0)).toBe(true)
  expect(buttons.map(button => button.linkId).sort()).toEqual([...linkedPdf.expectedLinkIds].sort())
  // Existing tests treat [data-page] as a page wrapper only; link buttons must
  // not hijack that contract.
  expect(buttons.every(button => !button.hasPageAttribute)).toBe(true)
  await expect(window.locator(`${LINK}[data-page]`)).toHaveCount(0)

  // Internal links live on the contents page, not in a sidebar or a second surface.
  await expect(window.locator(`[data-page="2"] ${LINK}, [data-page="3"] ${LINK}, [data-page="4"] ${LINK}`)).toHaveCount(0)
  await expect(window.locator('[data-sidebar], .sidebar, [role="complementary"]')).toHaveCount(0)

  // The overlay itself is an invisible hitbox over the printed contents text.
  const style = await links.first().evaluate((element) => {
    const computed = getComputedStyle(element)
    return { background: computed.backgroundColor, border: computed.borderTopWidth }
  })
  expect(['transparent', 'rgba(0, 0, 0, 0)']).toContain(style.background)
  expect(style.border).toBe('0px')

  // Clicking where the external URI annotation sits must do nothing: no
  // internal navigation (the annotation is skipped) and no external navigation.
  const pageBox = await window.locator('[data-page="1"]').boundingBox()
  expect(pageBox).not.toBeNull()
  const externalPoint = pdfRectCenterFraction(LINKED_ANNOTATIONS.external.rect, LINKED_PAGE_SIZES[0])
  const beforeUrl = window.url()
  await window.mouse.click(
    pageBox!.x + pageBox!.width * externalPoint.x,
    pageBox!.y + pageBox!.height * externalPoint.y
  )
  await expectActivePage(window, 1)
  expect(window.url()).toBe(beforeUrl)
})

test('clicking a resolvable contents link jumps to the target page and persists it', async ({ linkedPdf, userData }) => {
  const { window } = await launch(userData, linkedPdf)
  await openPdf(window, linkedPdf)

  const explicit = window.locator(linkSelector(linkedPdf.explicitLinkId))
  await expect(explicit).toHaveCount(1)
  await explicit.click()
  await expectActivePage(window, linkedPdf.explicitTargetPage)
  await expectScrolledToPage(window, linkedPdf.explicitTargetPage)
  await expect.poll(() => savedPage(userData)).toBe(linkedPdf.explicitTargetPage)

  // The second, name-tree-resolved link targets the same way.
  await goToPage(window, 1)
  await expect(window.locator(CONTENTS_LINKS)).toHaveCount(linkedPdf.expectedInternalLinkCount)
  const named = window.locator(linkSelector(linkedPdf.namedLinkId))
  await expect(named).toHaveCount(1)
  await named.click()
  await expectActivePage(window, linkedPdf.namedTargetPage)
  await expectScrolledToPage(window, linkedPdf.namedTargetPage)
  await expect.poll(() => savedPage(userData)).toBe(linkedPdf.namedTargetPage)
})

test('activates internal links from the keyboard', async ({ linkedPdf, userData }) => {
  const { window } = await launch(userData, linkedPdf)
  await openPdf(window, linkedPdf)

  const named = window.locator(linkSelector(linkedPdf.namedLinkId))
  await named.focus()
  await expect(named).toBeFocused()
  await named.press('Enter')
  await expectActivePage(window, linkedPdf.namedTargetPage)

  await goToPage(window, 1)
  const explicit = window.locator(linkSelector(linkedPdf.explicitLinkId))
  await explicit.focus()
  await expect(explicit).toBeFocused()
  await explicit.press('Space')
  await expectActivePage(window, linkedPdf.explicitTargetPage)
})

test('reports missing and invalid destinations without leaving the contents page', async ({ linkedPdf, userData }) => {
  const { window } = await launch(userData, linkedPdf)
  await openPdf(window, linkedPdf)

  await expect(window.locator(CONTENTS_LINKS)).toHaveCount(linkedPdf.expectedInternalLinkCount)
  await expectActivePage(window, 1)

  for (const linkId of linkedPdf.unresolvedLinkIds) {
    const button = window.locator(linkSelector(linkId))
    await expect(button).toHaveCount(1)
    await button.click()
    await expect(window.getByRole('status')).toContainText(/invalid target/i)
    await expectActivePage(window, 1)
    const metrics = await readMetrics(window)
    expect(metrics.scrollTop).toBeLessThanOrEqual(1)
    await window.getByRole('button', { name: 'Dismiss' }).click()
    await expect(window.getByRole('status')).toHaveCount(0)
  }
})

test('keeps internal-link hitboxes aligned with the page across zoom and stays clickable', async ({ linkedPdf, userData }) => {
  const { window } = await launch(userData, linkedPdf)
  await openPdf(window, linkedPdf)

  const before = await linkGeometry(window)
  expect(before).toHaveLength(linkedPdf.expectedInternalLinkCount)
  const pageHeightBefore = (await readMetrics(window)).pages[0].height

  await window.getByRole('button', { name: 'Zoom in' }).click()
  await expect(window.locator('.zoom-value')).toHaveText('130%')
  await expect.poll(async () => (await readMetrics(window)).pages[0].height).toBeGreaterThan(pageHeightBefore)
  await expect(window.locator(CONTENTS_LINKS)).toHaveCount(linkedPdf.expectedInternalLinkCount)
  await expect(window.locator(`${LINK}[data-page]`)).toHaveCount(0)

  const after = await linkGeometry(window)
  for (const previous of before) {
    const current = after.find(link => link.linkId === previous.linkId)
    expect(current).toBeDefined()
    // Normalised placement must not drift when the page is rescaled.
    expect(current!.left).toBeCloseTo(previous.left, 2)
    expect(current!.top).toBeCloseTo(previous.top, 2)
    expect(current!.width).toBeCloseTo(previous.width, 2)
    expect(current!.height).toBeCloseTo(previous.height, 2)
    expect(current!.pixelWidth).toBeGreaterThan(previous.pixelWidth)
  }

  const explicit = window.locator(linkSelector(linkedPdf.explicitLinkId))
  await explicit.click()
  await expectActivePage(window, linkedPdf.explicitTargetPage)
})

test('does not duplicate link overlays when a lazily rendered contents page is revisited', async ({ linkedPdf, userData }) => {
  const { window } = await launch(userData, linkedPdf)
  await openPdf(window, linkedPdf)
  await expect(window.locator(CONTENTS_LINKS)).toHaveCount(linkedPdf.expectedInternalLinkCount)

  // Leave the contents page far enough to fall outside the lazy render band.
  await goToPage(window, linkedPdf.namedTargetPage)
  await expectActivePage(window, linkedPdf.namedTargetPage)

  await goToPage(window, 1)
  await expectActivePage(window, 1)
  await expect(window.locator(CONTENTS_LINKS)).toHaveCount(linkedPdf.expectedInternalLinkCount)
  await expect(window.locator(LINK)).toHaveCount(linkedPdf.expectedInternalLinkCount)

  const buttons = await linkButtons(window)
  expect(new Set(buttons.map(button => button.linkId)).size).toBe(linkedPdf.expectedInternalLinkCount)
  expect(buttons.map(button => button.linkId).sort()).toEqual([...linkedPdf.expectedLinkIds].sort())

  // The re-rendered overlay is still a live hitbox.
  const explicit = window.locator(linkSelector(linkedPdf.explicitLinkId))
  await explicit.click()
  await expectActivePage(window, linkedPdf.explicitTargetPage)
})
