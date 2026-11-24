import type { PDFDocumentProxy } from 'pdfjs-dist'
import { resolveDestinationPage, type LinkDestination } from './pdf-links'

export type OutlineNodeLike = {
  title: string
  dest?: LinkDestination | null
  url?: string | null
  unsafeUrl?: string
  items?: OutlineNodeLike[]
  bold?: boolean
  italic?: boolean
}

export type OutlineItem = {
  title: string
  page: number | null
  bold: boolean
  italic: boolean
  children: OutlineItem[]
}

type OutlineDocument = Pick<PDFDocumentProxy, 'numPages' | 'getDestination' | 'getPageIndex'>

export async function loadOutline(doc: OutlineDocument, nodes: OutlineNodeLike[]): Promise<OutlineItem[]> {
  return Promise.all(nodes.map(async node => ({
    title: node.title,
    page: await resolveOutlinePage(doc, node.dest),
    bold: node.bold === true,
    italic: node.italic === true,
    children: await loadOutline(doc, node.items ?? [])
  })))
}

async function resolveOutlinePage(doc: OutlineDocument, destination: LinkDestination | null | undefined): Promise<number | null> {
  if (destination == null) return null
  try {
    return await resolveDestinationPage(doc, destination)
  } catch {
    // Keep the entry visible even when its destination cannot be resolved.
    return null
  }
}
