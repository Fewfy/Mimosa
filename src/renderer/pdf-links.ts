import type { PDFDocumentProxy } from 'pdfjs-dist'

/** A named destination or an explicit destination array. */
export type LinkDestination = string | unknown[]

export type InternalLink = {
  /** PDF annotation id; rendered as the DOM `data-link-id`. */
  id: string
  /** PDF user-space rect [x1, y1, x2, y2] with a bottom-left origin. */
  rect: [number, number, number, number]
  destination: LinkDestination
}

/** The subset of `PageViewport` used for rectangle conversion. */
export type ViewportLike = {
  width: number
  height: number
  convertToViewportPoint(x: number, y: number): readonly number[]
}

/** A page-relative box in [0, 1] fractions. */
export type NormalizedBox = {
  left: number
  top: number
  width: number
  height: number
}

type DestinationDocument = Pick<PDFDocumentProxy, 'numPages' | 'getDestination' | 'getPageIndex'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A PDF indirect reference, as exposed by `getPageIndex`. */
function isPageRef(value: unknown): value is { num: number; gen: number } {
  return isRecord(value) &&
    typeof value.num === 'number' && Number.isInteger(value.num) &&
    typeof value.gen === 'number' && Number.isInteger(value.gen)
}

/** Maps a zero-based page index to a 1-based page number, or null when out of range. */
function toPageNumber(zeroBasedIndex: number, numPages: number): number | null {
  if (!Number.isInteger(zeroBasedIndex)) return null
  if (zeroBasedIndex < 0 || zeroBasedIndex >= numPages) return null
  return zeroBasedIndex + 1
}

/**
 * Resolves an embedded link destination to a 1-based page number, or null when
 * it is malformed, missing or out of range.
 *
 * A string is a named destination looked up through `getDestination`. An
 * explicit array's first element is either a page reference (`getPageIndex`
 * returns a zero-based index) or a zero-based page index. Errors from
 * `getDestination` propagate; a failing `getPageIndex` just means the
 * reference is not a usable page.
 */
export async function resolveDestinationPage(
  doc: DestinationDocument,
  destination: LinkDestination
): Promise<number | null> {
  let resolved: unknown = destination
  if (typeof destination === 'string') resolved = await doc.getDestination(destination)

  if (!Array.isArray(resolved) || resolved.length === 0) return null
  const [first] = resolved

  if (isPageRef(first)) {
    let index: number
    try {
      index = await doc.getPageIndex({ num: first.num, gen: first.gen })
    } catch {
      return null
    }
    return toPageNumber(index, doc.numPages)
  }

  if (typeof first === 'number') return toPageNumber(first, doc.numPages)
  return null
}

function toPdfRect(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const [x1, y1, x2, y2] = value
  if (typeof x1 !== 'number' || !Number.isFinite(x1)) return null
  if (typeof y1 !== 'number' || !Number.isFinite(y1)) return null
  if (typeof x2 !== 'number' || !Number.isFinite(x2)) return null
  if (typeof y2 !== 'number' || !Number.isFinite(y2)) return null
  return [x1, y1, x2, y2]
}

/**
 * Keeps `/Link` annotations with a string or array destination and a usable
 * rect. Annotations with a URL target are skipped.
 */
export function collectInternalLinks(annotations: unknown[]): InternalLink[] {
  if (!Array.isArray(annotations)) return []
  const links: InternalLink[] = []
  annotations.forEach((annotation, index) => {
    if (!isRecord(annotation)) return
    if (annotation.subtype !== 'Link') return
    if (annotation.url != null || annotation.unsafeUrl != null) return

    const destination = annotation.dest
    if (typeof destination !== 'string' && !Array.isArray(destination)) return

    const rect = toPdfRect(annotation.rect)
    if (!rect) return

    const id = typeof annotation.id === 'string' && annotation.id.length > 0
      ? annotation.id
      : `link-${index}`
    links.push({ id, rect, destination })
  })
  return links
}

/**
 * Converts a PDF-space rectangle into page-relative fractions by projecting
 * both corners through the viewport. Using the viewport transform instead of
 * assuming a y-flip keeps overlays aligned under rotation, cropping and zoom.
 * min/abs handles either corner order; fractions are invariant across zoom.
 */
export function rectToNormalizedBox(rect: readonly number[], viewport: ViewportLike): NormalizedBox {
  const [x1, y1, x2, y2] = rect
  const [ax, ay] = viewport.convertToViewportPoint(x1, y1)
  const [bx, by] = viewport.convertToViewportPoint(x2, y2)

  const width = viewport.width
  const height = viewport.height
  if (!(width > 0) || !(height > 0)) return { left: 0, top: 0, width: 0, height: 0 }

  return {
    left: Math.min(ax, bx) / width,
    top: Math.min(ay, by) / height,
    width: Math.abs(bx - ax) / width,
    height: Math.abs(by - ay) / height
  }
}
