import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Deterministic, byte-correct multi-page PDF used by the continuous-scroll E2E
 * tests. Page heights are intentionally mixed so the reserved stack geometry
 * (rather than a uniform viewport) drives scrolling.
 */

export type FixturePageSize = { width: number; height: number }

export const FIXTURE_PAGE_SIZES: readonly FixturePageSize[] = [
  { width: 612, height: 792 },
  { width: 612, height: 540 },
  { width: 612, height: 900 },
  { width: 612, height: 648 },
  { width: 612, height: 1020 }
]

/** A two-page document shorter than any normal reader viewport. */
export const SHORT_FIXTURE_PAGE_SIZES: readonly FixturePageSize[] = [
  { width: 612, height: 240 },
  { width: 612, height: 240 }
]

export const SEARCH_MARKER = 'quokka'
export const SEARCH_MARKER_PAGE = 5

export type PdfFixture = {
  directory: string
  path: string
  pageSizes: readonly FixturePageSize[]
  searchMarker: string
  searchMarkerPage: number
}

function pageContent(page: number, size: FixturePageSize): string {
  const marker = page === SEARCH_MARKER_PAGE
    ? `Lazy search marker ${SEARCH_MARKER}`
    : `Reading flow checkpoint ${['alpha', 'bravo', 'charlie', 'delta', 'echo'][page - 1]}`
  const topY = size.height - 96
  return [
    'BT',
    '/F1 26 Tf',
    `72 ${topY} Td`,
    `(MIMOSA PAGE ${page}) Tj`,
    '0 -46 Td',
    '/F1 16 Tf',
    `(${marker}) Tj`,
    '0 -30 Td',
    `(Continuous scrolling fixture line ${page} alpha bravo charlie.) Tj`,
    '0 -26 Td',
    '(Shared underline phrase on every page.) Tj',
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

/** Builds a fully self-consistent PDF (xref offsets included) in memory. */
export function buildContinuousScrollPdf(pageSizes: readonly FixturePageSize[] = FIXTURE_PAGE_SIZES): Buffer {
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')
  const parts: Buffer[] = [header]
  const offsets: number[] = []
  let byteLength = header.length

  const addObject = (body: Buffer): void => {
    const objectNumber = offsets.length + 1
    const object = Buffer.concat([
      Buffer.from(`${objectNumber} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1')
    ])
    offsets.push(byteLength)
    parts.push(object)
    byteLength += object.length
  }

  const pageCount = pageSizes.length
  const fontObjectNumber = 3 + pageCount * 2
  const kids = pageSizes.map((_, index) => `${3 + index * 2} 0 R`).join(' ')

  addObject(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'))
  addObject(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`, 'latin1'))

  pageSizes.forEach((size, index) => {
    const pageNumber = index + 1
    const contentObjectNumber = 3 + index * 2 + 1
    addObject(Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] ` +
      `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`,
      'latin1'
    ))
    addObject(streamObject(pageContent(pageNumber, size)))
  })

  addObject(Buffer.from(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    'latin1'
  ))

  const xrefOffset = byteLength
  const objectCount = offsets.length
  const xrefLines = ['xref', `0 ${objectCount + 1}`, '0000000000 65535 f ']
  for (const offset of offsets) xrefLines.push(`${String(offset).padStart(10, '0')} 00000 n `)
  const trailer = [
    ...xrefLines,
    'trailer',
    `<< /Size ${objectCount + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    ''
  ].join('\n')
  parts.push(Buffer.from(trailer, 'latin1'))

  return Buffer.concat(parts)
}

/** Writes the fixture into a fresh OS temp directory. */
export async function createContinuousScrollPdf(
  pageSizes: readonly FixturePageSize[] = FIXTURE_PAGE_SIZES
): Promise<PdfFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mimosa-e2e-pdf-'))
  const path = join(directory, 'continuous-scroll-fixture.pdf')
  await writeFile(path, buildContinuousScrollPdf(pageSizes))
  return {
    directory,
    path,
    pageSizes,
    searchMarker: SEARCH_MARKER,
    searchMarkerPage: SEARCH_MARKER_PAGE
  }
}
