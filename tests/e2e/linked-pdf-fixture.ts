import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Deterministic, byte-correct fixture for the clickable embedded-link E2E
 * tests. Page 1 is a printed table of contents carrying five link annotations:
 *
 *   1. explicit destination page ref  -> page 3   (resolvable)
 *   2. named destination via Names    -> page 4   (resolvable)
 *   3. missing named destination      -> button kept, reports invalid target
 *   4. explicit destination page ref to a non-existent page object
 *                                     -> button kept, reports invalid target
 *   5. external URI action            -> ignored entirely
 *
 * A sixth printed "Chapter Three" row has no annotation at all. Every internal
 * destination keeps a link button so the reader can report an unusable target;
 * only the external URI annotation is skipped.
 */

export type LinkedPageSize = { width: number; height: number }

export const LINKED_PAGE_SIZES: readonly LinkedPageSize[] = [
  { width: 612, height: 792 },
  { width: 612, height: 792 },
  { width: 612, height: 792 },
  { width: 612, height: 792 }
]

/** PDF user-space rect as [x1, y1, x2, y2] with a bottom-left origin. */
export type PdfRect = readonly [number, number, number, number]

export type LinkedAnnotationGeometry = {
  /** Resolvable explicit destination page ref. */
  explicit: { rect: PdfRect; targetPage: number }
  /** Resolvable destination resolved from the /Names /Dests name tree. */
  named: { rect: PdfRect; targetPage: number }
  /** Destination name absent from the name tree. */
  missing: { rect: PdfRect }
  /** Destination page ref points at an object that is not a page. */
  invalid: { rect: PdfRect }
  /** URI action; must never be treated as an internal destination. */
  external: { rect: PdfRect; url: string }
}

export const LINKED_ANNOTATIONS: LinkedAnnotationGeometry = {
  explicit: { rect: [72, 640, 320, 672], targetPage: 3 },
  named: { rect: [72, 596, 320, 628], targetPage: 4 },
  missing: { rect: [72, 552, 320, 584] },
  invalid: { rect: [72, 508, 320, 540] },
  external: { rect: [72, 464, 320, 496], url: 'https://example.com/mimosa-external-link' }
}

export const NAMED_DESTINATION = 'chapter-two'
export const MISSING_DESTINATION = 'missing-chapter'
export const EXTERNAL_LINK_URL = LINKED_ANNOTATIONS.external.url

export type LinkedPdfFixture = {
  directory: string
  path: string
  pageSizes: readonly LinkedPageSize[]
  contentsPage: number
  explicitTargetPage: number
  namedTargetPage: number
  /** Buttons for every internal destination, including unusable ones. */
  expectedInternalLinkCount: number
  /** Ignored URI-action annotation never becomes a button. */
  externalLinkUrl: string
  /** `data-link-id` of the explicit-destination contents link. */
  explicitLinkId: string
  /** `data-link-id` of the name-tree-resolved contents link. */
  namedLinkId: string
  /** Link ids that must exist as buttons: every internal annotation. */
  expectedLinkIds: readonly string[]
  /** Link ids whose destination cannot be resolved to a page. */
  unresolvedLinkIds: readonly string[]
}

// Object numbers are fixed so destination arrays and annotation refs stay
// independent of generation order.
const CATALOG = 1
const PAGES = 2
const FONT = 3
const NAMES_DESTS = 4
const EXPLICIT_ANNOT = 5
const NAMED_ANNOT = 6
const MISSING_ANNOT = 7
const INVALID_ANNOT = 8
const EXTERNAL_ANNOT = 9
const PAGE_1 = 10
const CONTENT_1 = 11
const PAGE_2 = 12
const CONTENT_2 = 13
const PAGE_3 = 14
const CONTENT_3 = 15
const PAGE_4 = 16
const CONTENT_4 = 17

/**
 * Annotation ids PDF.js assigns to the fixture objects. The renderer exposes
 * them as `data-link-id`; `5R`/`6R` are the two resolvable contents links.
 */
export const LINK_IDS = {
  explicit: `${EXPLICIT_ANNOT}R`,
  named: `${NAMED_ANNOT}R`,
  missing: `${MISSING_ANNOT}R`,
  invalid: `${INVALID_ANNOT}R`,
  external: `${EXTERNAL_ANNOT}R`
} as const

function contentsStream(): string {
  return [
    'BT',
    '/F1 24 Tf',
    '72 720 Td',
    '(MIMOSA CONTENTS) Tj',
    '/F1 15 Tf',
    '0 -70 Td',
    '(Chapter One - embedded link to page 3) Tj',
    '0 -44 Td',
    '(Chapter Two - named link to page 4) Tj',
    '0 -44 Td',
    '(Broken entry - missing destination) Tj',
    '0 -44 Td',
    '(Invalid entry - bad page reference) Tj',
    '0 -44 Td',
    '(External entry - website URL) Tj',
    '0 -44 Td',
    '(Chapter Three - plain printed entry) Tj',
    'ET'
  ].join('\n')
}

function pageStream(page: number): string {
  const marker = page === 3 ? 'TARGET PAGE 3' : page === 4 ? 'TARGET PAGE 4' : `CHECKPOINT PAGE ${page}`
  return [
    'BT',
    '/F1 26 Tf',
    '72 700 Td',
    `(MIMOSA PAGE ${page}) Tj`,
    '0 -46 Td',
    '/F1 15 Tf',
    `(${marker}) Tj`,
    'ET',
    'BT',
    '/F1 14 Tf',
    '72 64 Td',
    `(BOTTOM MARKER PAGE ${page}) Tj`,
    'ET'
  ].join('\n')
}

function streamObject(content: string): Buffer {
  const data = Buffer.from(content, 'latin1')
  // /Length counts the stream bytes plus the newline that precedes endstream.
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length + 1} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1')
  ])
}

function pageObject(page: number, contentObject: number, annotations: number[] | null): string {
  const size = LINKED_PAGE_SIZES[page - 1]
  const annots = annotations && annotations.length > 0
    ? ` /Annots [${annotations.map(ref => `${ref} 0 R`).join(' ')}]`
    : ''
  return `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${size.width} ${size.height}] ` +
    `/Contents ${contentObject} 0 R${annots} >>`
}

function linkAnnotation(rect: PdfRect, dest: string): string {
  const [x1, y1, x2, y2] = rect
  return `<< /Type /Annot /Subtype /Link /Rect [${x1} ${y1} ${x2} ${y2}] /Border [0 0 0] /Dest ${dest} >>`
}

/** Builds a fully self-consistent PDF (xref offsets included) in memory. */
export function buildLinkedPdf(pageSizes: readonly LinkedPageSize[] = LINKED_PAGE_SIZES): Buffer {
  if (pageSizes.length !== 4) throw new Error('The linked-link fixture requires exactly four pages.')
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')
  const parts: Buffer[] = [header]
  const offsets: number[] = []
  let byteLength = header.length

  const addObject = (body: Buffer | string): void => {
    const objectNumber = offsets.length + 1
    const object = Buffer.concat([
      Buffer.from(`${objectNumber} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1')
    ])
    offsets.push(byteLength)
    parts.push(object)
    byteLength += object.length
  }

  addObject(`<< /Type /Catalog /Pages ${PAGES} 0 R /Names << /Dests ${NAMES_DESTS} 0 R >> >>`)
  const kids = [PAGE_1, PAGE_2, PAGE_3, PAGE_4].map(ref => `${ref} 0 R`).join(' ')
  addObject(
    `<< /Type /Pages /Kids [${kids}] /Count 4 ` +
    `/Resources << /Font << /F1 ${FONT} 0 R >> >> >>`
  )
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  // Name tree: the annotation below stores the string "chapter-two" as /Dest.
  addObject(`<< /Names [(${NAMED_DESTINATION}) [${PAGE_4} 0 R /Fit]] >>`)

  const { explicit, named, missing, invalid, external } = LINKED_ANNOTATIONS
  addObject(linkAnnotation(explicit.rect, `[${PAGE_3} 0 R /XYZ 0 792 0]`))
  addObject(linkAnnotation(named.rect, `(${NAMED_DESTINATION})`))
  addObject(linkAnnotation(missing.rect, `(${MISSING_DESTINATION})`))
  // 999 is deliberately not a page object; the destination stays unusable.
  addObject(linkAnnotation(invalid.rect, '[999 0 R /XYZ 0 792 0]'))
  const [ex1, ey1, ex2, ey2] = external.rect
  addObject(
    `<< /Type /Annot /Subtype /Link /Rect [${ex1} ${ey1} ${ex2} ${ey2}] /Border [0 0 0] ` +
    `/A << /S /URI /URI (${external.url}) >> >>`
  )

  addObject(pageObject(1, CONTENT_1, [EXPLICIT_ANNOT, NAMED_ANNOT, MISSING_ANNOT, INVALID_ANNOT, EXTERNAL_ANNOT]))
  addObject(streamObject(contentsStream()))
  addObject(pageObject(2, CONTENT_2, null))
  addObject(streamObject(pageStream(2)))
  addObject(pageObject(3, CONTENT_3, null))
  addObject(streamObject(pageStream(3)))
  addObject(pageObject(4, CONTENT_4, null))
  addObject(streamObject(pageStream(4)))

  const xrefOffset = byteLength
  const objectCount = offsets.length
  const xrefLines = ['xref', `0 ${objectCount + 1}`, '0000000000 65535 f ']
  for (const offset of offsets) xrefLines.push(`${String(offset).padStart(10, '0')} 00000 n `)
  const trailer = [
    ...xrefLines,
    'trailer',
    `<< /Size ${objectCount + 1} /Root ${CATALOG} 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    ''
  ].join('\n')
  parts.push(Buffer.from(trailer, 'latin1'))

  return Buffer.concat(parts)
}

/** Writes the fixture into a fresh OS temp directory. */
export async function createLinkedPdf(
  pageSizes: readonly LinkedPageSize[] = LINKED_PAGE_SIZES
): Promise<LinkedPdfFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mimosa-e2e-linked-pdf-'))
  const path = join(directory, 'internal-links-fixture.pdf')
  await writeFile(path, buildLinkedPdf(pageSizes))
  return {
    directory,
    path,
    pageSizes,
    contentsPage: 1,
    explicitTargetPage: LINKED_ANNOTATIONS.explicit.targetPage,
    namedTargetPage: LINKED_ANNOTATIONS.named.targetPage,
    expectedInternalLinkCount: 4,
    externalLinkUrl: LINKED_ANNOTATIONS.external.url,
    explicitLinkId: LINK_IDS.explicit,
    namedLinkId: LINK_IDS.named,
    expectedLinkIds: [LINK_IDS.explicit, LINK_IDS.named, LINK_IDS.missing, LINK_IDS.invalid],
    unresolvedLinkIds: [LINK_IDS.missing, LINK_IDS.invalid]
  }
}
