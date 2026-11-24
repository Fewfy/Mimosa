import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import type { UnderlineAnnotation } from '../shared/contracts'
import type { PageLayoutEntry } from './continuous-layout'
import { collectInternalLinks, rectToNormalizedBox, type LinkDestination, type NormalizedBox } from './pdf-links'

type PageViewProps = {
  doc: PDFDocumentProxy
  entry: PageLayoutEntry
  scale: number
  query: string
  annotations: UnderlineAnnotation[]
  readerRef: RefObject<HTMLElement | null>
  onEditAnnotation: (id: string) => void
  onInternalLink: (destination: LinkDestination) => void
  onRenderError: (message: string) => void
}

type PositionedLink = { id: string; destination: LinkDestination; box: NormalizedBox }

/** Pages within this band around the reader stay rendered. */
const RENDER_MARGIN = '150% 0px'

export const PageView = memo(function PageView({ doc, entry, scale, query, annotations, readerRef, onEditAnnotation, onInternalLink, onRenderError }: PageViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const queryRef = useRef(query)
  const [nearViewport, setNearViewport] = useState(false)
  const [links, setLinks] = useState<PositionedLink[]>([])

  // Kept current so a page that finishes rendering late can apply the latest query.
  queryRef.current = query

  useEffect(() => {
    const reader = readerRef.current
    const target = containerRef.current
    if (!reader || !target) return
    const observer = new IntersectionObserver(entries => {
      const last = entries[entries.length - 1]
      if (last) setNearViewport(last.isIntersecting)
    }, { root: reader, rootMargin: RENDER_MARGIN })
    observer.observe(target)
    return () => observer.disconnect()
  }, [readerRef, doc, entry.page])

  // Link overlays follow the same lazy lifecycle as page rendering: only pages
  // inside the render band fetch annotations, and the overlay is cleared before
  // any re-fetch or when the page leaves the band. Replacing (never appending)
  // the state list keeps a revisited page from stacking duplicate hotspots.
  useEffect(() => {
    let cancelled = false
    setLinks([])
    if (!nearViewport) return
    void (async () => {
      try {
        const pdfPage = await doc.getPage(entry.page)
        if (cancelled) return
        const annotations = await pdfPage.getAnnotations()
        if (cancelled) return
        const viewport = pdfPage.getViewport({ scale })
        const positioned = collectInternalLinks(annotations).map(link => ({
          id: link.id,
          destination: link.destination,
          box: rectToNormalizedBox(link.rect, viewport)
        }))
        setLinks(positioned)
      } catch (error) {
        if (cancelled) return
        const name = (error as { name?: string } | null)?.name
        // Annotation data is supplementary; a cancelled worker or unreadable
        // annotation dictionary must not interrupt reading.
        if (name === 'RenderingCancelledException' || name === 'AbortException') return
        console.error(`Could not load PDF links on page ${entry.page}.`, error)
        onRenderError('Could not load the links on this page.')
      }
    })()
    return () => { cancelled = true }
  }, [doc, entry.page, scale, nearViewport, onRenderError])

  useEffect(() => {
    if (!nearViewport || !canvasRef.current || !textLayerRef.current) return
    let cancelled = false
    let renderTask: RenderTask | null = null
    let textLayer: TextLayer | null = null
    let renderDone = false
    let textDone = false

    void (async () => {
      const pdfPage = await doc.getPage(entry.page)
      if (cancelled || !canvasRef.current || !textLayerRef.current) return

      const viewport = pdfPage.getViewport({ scale })
      const canvas = canvasRef.current
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not draw this PDF page.')
      const outputScale = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      renderTask = pdfPage.render({
        canvas,
        canvasContext: context,
        viewport,
        ...(outputScale === 1 ? {} : { transform: [outputScale, 0, 0, outputScale, 0, 0] })
      })
      // Attach rejection handling before yielding: cleanup may cancel the task
      // while getTextContent is still pending.
      const renderPromise = renderTask.promise.finally(() => { renderDone = true })
      void renderPromise.catch(() => undefined)
      const textContent = await pdfPage.getTextContent()
      if (cancelled || !textLayerRef.current) return

      textLayerRef.current.replaceChildren()
      textLayer = new TextLayer({ textContentSource: textContent, container: textLayerRef.current, viewport })
      const textPromise = textLayer.render().finally(() => { textDone = true })
      void textPromise.catch(() => undefined)
      await Promise.all([renderPromise, textPromise])
      if (cancelled) return
      applySearch(textLayerRef.current, queryRef.current)
    })().catch(error => {
      if (cancelled) return
      const name = (error as { name?: string } | null)?.name
      if (name === 'RenderingCancelledException' || name === 'AbortException') return
      onRenderError(error instanceof Error ? error.message : 'Could not render this page.')
    })

    return () => {
      cancelled = true
      // Only cancel work that has not already settled; posted cancel calls on a
      // finished PDF.js task re-enter its callback with a spurious error.
      if (!renderDone) renderTask?.cancel()
      if (!textDone) textLayer?.cancel()
      // Drop rendered DOM and the canvas backing store while the page is far
      // offscreen; otherwise re-entry appends duplicate text layer nodes and
      // every visited page keeps its bitmap.
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
        canvas.style.width = ''
        canvas.style.height = ''
      }
      textLayerRef.current?.replaceChildren()
    }
  }, [doc, entry.page, scale, nearViewport, onRenderError])

  // Search only touches text-layer spans, so the canvas is never redrawn.
  useEffect(() => {
    if (textLayerRef.current) applySearch(textLayerRef.current, query)
  }, [query])

  const pageAnnotations = annotations.filter(annotation => annotation.page === entry.page)
  return <div
    ref={containerRef}
    className="page-view"
    data-page={entry.page}
    style={{ width: entry.width, height: entry.height, '--total-scale-factor': String(scale) } as CSSProperties}
  >
    <canvas ref={canvasRef} />
    <div ref={textLayerRef} className="text-layer" />
    {links.map(link => <button
      type="button"
      className="pdf-internal-link"
      key={link.id}
      aria-label="Go to linked page"
      data-link-id={link.id}
      title="Go to linked page"
      style={{
        left: `${link.box.left * 100}%`,
        top: `${link.box.top * 100}%`,
        width: `${link.box.width * 100}%`,
        height: `${link.box.height * 100}%`
      }}
      onClick={() => onInternalLink(link.destination)}
    />)}
    {pageAnnotations.map(annotation => <div className="annotation-group" key={annotation.id}>
      {annotation.rects.map((rect, index) => <button
        type="button"
        className="underline-mark"
        key={index}
        aria-label="Edit underline comment"
        data-annotation-id={annotation.id}
        title={annotation.comment ? `${annotation.text} — ${annotation.comment}` : annotation.text}
        style={{ left: `${rect.x * 100}%`, top: `${(rect.y + rect.height) * 100 - .4}%`, width: `${rect.width * 100}%` }}
        onClick={() => onEditAnnotation(annotation.id)}
      />)}
    </div>)}
  </div>
})

function applySearch(layer: HTMLElement, value: string): void {
  layer.querySelectorAll('.search-hit').forEach(node => node.classList.remove('search-hit'))
  const terms = value.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return
  layer.querySelectorAll('span').forEach(span => {
    if (terms.some(term => span.textContent?.toLocaleLowerCase().includes(term))) span.classList.add('search-hit')
  })
}
