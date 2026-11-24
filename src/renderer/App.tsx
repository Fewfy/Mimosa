import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { OpenedDocument, OpenRecentResult, RecentDocument, Rect, UnderlineAnnotation } from '../shared/contracts'
import { AiPanel } from './AiPanel'
import { AnnotationEditor } from './AnnotationEditor'
import { layoutAnchorAt, layoutOffsetFor, layoutPages, type PageSize, type ReadingAnchor } from './continuous-layout'
import { OutlineSidebar } from './OutlineSidebar'
import { buildPageContext, type PageTextItem } from './page-context'
import { PageView } from './PageView'
import { loadOutline, type OutlineItem } from './pdf-outline'
import { resolveDestinationPage, type LinkDestination } from './pdf-links'
import { RecentDocuments } from './RecentDocuments'
import { pdfAssetUrls } from './pdf-assets'
import './styles.css'

GlobalWorkerOptions.workerSrc = workerUrl

type SelectionSnapshot = { text: string; page: number | null; crossPage: boolean; rects: Rect[] }
type OpenPayload = OpenedDocument | OpenRecentResult | null
type RecentIssue = 'missing' | 'changed'
type AskTarget = { annotationId: string | null; page: number; text: string; rects: Rect[] | null }

const MIN_AI_WIDTH = 300
const MAX_AI_WIDTH = 720
const DEFAULT_AI_WIDTH = 380
const AI_WIDTH_KEY = 'mimosa.ai-panel-width'

function storedAiWidth(): number {
  try {
    const value = Number(localStorage.getItem(AI_WIDTH_KEY))
    return Number.isFinite(value) && value > 0 ? Math.min(MAX_AI_WIDTH, Math.max(MIN_AI_WIDTH, value)) : DEFAULT_AI_WIDTH
  } catch {
    return DEFAULT_AI_WIDTH
  }
}

export default function App() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [opened, setOpened] = useState<OpenedDocument | null>(null)
  const [sizes, setSizes] = useState<PageSize[] | null>(null)
  const [activePage, setActivePage] = useState(1)
  const [pageDraft, setPageDraft] = useState('1')
  const [editingPage, setEditingPage] = useState(false)
  const [scale, setScale] = useState(1.15)
  const [query, setQuery] = useState('')
  const [selectedText, setSelectedText] = useState('')
  const [annotations, setAnnotations] = useState<UnderlineAnnotation[]>([])
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [message, setMessage] = useState('')
  const [translation, setTranslation] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [translationConfirmed, setTranslationConfirmed] = useState(false)
  const [restored, setRestored] = useState(false)
  const [opening, setOpening] = useState(false)
  const [readerHeight, setReaderHeight] = useState(0)
  const [annotationEditor, setAnnotationEditor] = useState<{ id: string } | null>(null)
  const [askTarget, setAskTarget] = useState<AskTarget | null>(null)
  const [aiQuestion, setAiQuestion] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiConfirmed, setAiConfirmed] = useState(false)
  const [aiWidth, setAiWidth] = useState(storedAiWidth)
  const [recent, setRecent] = useState<RecentDocument[]>([])
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentError, setRecentError] = useState('')
  const [recentIssues, setRecentIssues] = useState<Record<string, RecentIssue>>({})
  const openingRef = useRef(false)
  const readerRef = useRef<HTMLElement>(null)
  const loadingTaskRef = useRef<ReturnType<typeof getDocument> | null>(null)
  // Identity of the document currently shown. Updated synchronously so an
  // asynchronous link resolution can tell whether it still owns the reader.
  const currentDocRef = useRef<PDFDocumentProxy | null>(null)
  // Monotonic counter so only the most recent link click may navigate.
  const navigationRequestRef = useRef(0)
  const goToPageRef = useRef<(page: number) => void>(() => undefined)
  const selectionRef = useRef<SelectionSnapshot | null>(null)
  const restoreTargetRef = useRef<number | null>(null)
  const pendingAnchorRef = useRef<ReadingAnchor | null>(null)
  const lastSavedPageRef = useRef<number | null>(null)
  const skipBlurCommitRef = useRef(false)
  const pageTextRef = useRef<Map<number, PageTextItem[]>>(new Map())
  const aiWidthRef = useRef(aiWidth)
  const annotationsRef = useRef(annotations)
  aiWidthRef.current = aiWidth
  annotationsRef.current = annotations

  const layout = useMemo(() => layoutPages(sizes ?? [], scale), [sizes, scale])

  useEffect(() => () => {
    const task = loadingTaskRef.current
    loadingTaskRef.current = null
    if (task) void task.destroy().catch(() => undefined)
  }, [])

  const refreshRecent = useCallback(async () => {
    setRecentLoading(true)
    try {
      const items = await window.mimosa.listRecent()
      setRecent(items)
      setRecentError('')
    } catch {
      setRecentError('Could not load recent documents.')
    } finally {
      setRecentLoading(false)
    }
  }, [])

  useEffect(() => { void refreshRecent() }, [refreshRecent])

  function resetWorkspace() {
    // Invalidate any in-flight link navigation before tearing the reader down.
    navigationRequestRef.current += 1
    currentDocRef.current = null
    setRestored(false)
    restoreTargetRef.current = null
    pendingAnchorRef.current = null
    lastSavedPageRef.current = null
    selectionRef.current = null
    setSelectedText('')
    setTranslation('')
    setQuery('')
    setEditingPage(false)
    skipBlurCommitRef.current = false
    setAnnotationEditor(null)
    setAskTarget(null)
    setAiQuestion('')
    setAiBusy(false)
    setAiError('')
    pageTextRef.current.clear()
    setDoc(null)
    setSizes(null)
    setOpened(null)
    setAnnotations([])
    setOutline([])
    setActivePage(1)
    setPageDraft('1')
    setMessage('')
  }

  async function destroyLoadingTask(task: ReturnType<typeof getDocument> | null) {
    if (!task) return
    if (loadingTaskRef.current === task) loadingTaskRef.current = null
    try { await task.destroy() } catch (error) { console.error('Could not release the previous PDF.', error) }
  }

  async function loadDocument(result: OpenedDocument) {
    resetWorkspace()
    // Let the previous page stack unmount before the old worker is destroyed.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await destroyLoadingTask(loadingTaskRef.current)
    const assetUrls = pdfAssetUrls(window.location.href)
    const loading = getDocument({ data: new Uint8Array(result.bytes), ...assetUrls, cMapPacked: true })
    loadingTaskRef.current = loading
    try {
      const pdf = await loading.promise
      const loadedOutline = await loadOutline(pdf, (await pdf.getOutline()) ?? [])
      const measured = await Promise.all(Array.from({ length: pdf.numPages }, (_, index) => pdf.getPage(index + 1).then(page => {
        const viewport = page.getViewport({ scale: 1 })
        return { width: viewport.width, height: viewport.height }
      })))
      const savedPage = Math.min(Math.max(1, Math.floor(result.page) || 1), pdf.numPages)
      restoreTargetRef.current = savedPage
      lastSavedPageRef.current = savedPage
      currentDocRef.current = pdf
      setSizes(measured)
      setDoc(pdf)
      setOpened(result)
      setAnnotations(result.annotations)
      setOutline(loadedOutline)
      setActivePage(savedPage)
      setPageDraft(String(savedPage))
      setMessage('')
    } catch (error) {
      await destroyLoadingTask(loading)
      throw error
    }
  }

  // The normal, recent, and located open paths share the synchronous mutex and
  // the same loading body so only one PDF worker can be replaced at a time.
  async function beginOpen(load: () => Promise<OpenPayload>, recentId?: string) {
    if (openingRef.current) return
    openingRef.current = true
    setOpening(true)
    try {
      const result = await load()
      if (!result) return
      let document: OpenedDocument
      if ('status' in result) {
        if (result.status !== 'opened') {
          if (recentId) setRecentIssues(current => ({ ...current, [recentId]: result.status }))
          setMessage(result.status === 'missing'
            ? `“${result.name}” is missing from its saved location. Choose Locate to find the file.`
            : `“${result.name}” has changed since it was last opened. Choose Locate to verify the file.`)
          return
        }
        document = result.document
      } else {
        document = result
      }
      await loadDocument(document)
      setRecentIssues(current => {
        const next = { ...current }
        delete next[document.id]
        if (recentId) delete next[recentId]
        return next
      })
      void refreshRecent()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open this PDF.')
    } finally {
      openingRef.current = false
      setOpening(false)
    }
  }

  function openPdf() {
    return beginOpen(() => window.mimosa.openPdf())
  }

  function openRecentDocument(id: string) {
    return beginOpen(() => window.mimosa.openRecent(id), id)
  }

  function locateRecentDocument(id: string) {
    return beginOpen(() => window.mimosa.locateRecent(id), id)
  }

  async function goHome() {
    if (openingRef.current) return
    const task = loadingTaskRef.current
    loadingTaskRef.current = null
    resetWorkspace()
    void refreshRecent()
    // Unmount the reader before the worker is released.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    if (task) {
      try { await task.destroy() } catch (error) { console.error('Could not release the previous PDF.', error) }
    }
  }

  useLayoutEffect(() => {
    const reader = readerRef.current
    if (!reader) return
    setReaderHeight(reader.clientHeight)
    const observer = new ResizeObserver(() => setReaderHeight(reader.clientHeight))
    observer.observe(reader)
    return () => observer.disconnect()
  }, [doc])

  // Restore the stored reading position once the reserved page stack exists and
  // only then allow observed page changes to be written back.
  useEffect(() => {
    const target = restoreTargetRef.current
    if (!doc || layout.length === 0 || target === null) return
    const frame = requestAnimationFrame(() => {
      const reader = readerRef.current
      if (!reader) return
      reader.scrollTop = layoutOffsetFor(layout, target, 0)
      restoreTargetRef.current = null
      lastSavedPageRef.current = target
      setActivePage(target)
      setRestored(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [doc, layout, readerHeight])

  // Apply a zoom anchor after the resized stack has been committed.
  useEffect(() => {
    const pending = pendingAnchorRef.current
    if (!pending || layout.length === 0) return
    const reader = readerRef.current
    if (!reader) return
    pendingAnchorRef.current = null
    reader.scrollTop = layoutOffsetFor(layout, pending.page, pending.fraction)
  }, [layout])

  useEffect(() => {
    if (!opened || !restored) return
    if (lastSavedPageRef.current === activePage) return
    lastSavedPageRef.current = activePage
    void window.mimosa.savePage(opened.id, activePage).catch(() => setMessage('Could not save the reading position.'))
  }, [opened, activePage, restored])

  useEffect(() => {
    const reader = readerRef.current
    if (!reader || !restored || layout.length === 0) return
    const handleScroll = () => {
      // Chromium rounds scroll offsets to device pixels, sometimes just below a page boundary.
      const anchor = layoutAnchorAt(layout, reader.scrollTop + 0.5 / window.devicePixelRatio + 0.01)
      setActivePage(current => current === anchor.page ? current : anchor.page)
    }
    reader.addEventListener('scroll', handleScroll, { passive: true })
    return () => reader.removeEventListener('scroll', handleScroll)
  }, [layout, restored])

  useEffect(() => {
    if (!editingPage) setPageDraft(String(activePage))
  }, [activePage, editingPage])

  const handleRenderError = useCallback((text: string) => setMessage(text), [])

  const openAnnotationEditor = useCallback((id: string) => setAnnotationEditor({ id }), [])

  const saveAnnotationComment = useCallback(async (annotation: UnderlineAnnotation, comment: string | undefined) => {
    if (!opened) throw new Error('No document is open.')
    // Merge onto the latest copy so a comment saved while an AI answer arrives
    // cannot drop the conversation that was added meanwhile.
    const next: UnderlineAnnotation = { ...(annotationsRef.current.find(item => item.id === annotation.id) ?? annotation) }
    if (comment === undefined) delete next.comment
    else next.comment = comment
    // Persist first; the editor only closes after this resolves.
    await window.mimosa.saveAnnotation(opened.id, next)
    setAnnotations(current => current.map(item => item.id === next.id ? next : item))
    setMessage(comment === undefined ? 'Comment removed.' : 'Comment saved.')
  }, [opened])

  const deleteUnderline = useCallback(async (id: string) => {
    if (!opened) throw new Error('No document is open.')
    await window.mimosa.deleteAnnotation(opened.id, id)
    setAnnotations(current => current.filter(item => item.id !== id))
    setAnnotationEditor(current => (current?.id === id ? null : current))
    setAskTarget(current => (current?.annotationId === id ? null : current))
    setMessage('Underline removed.')
  }, [opened])

  function askAboutAnnotation(id: string) {
    const annotation = annotations.find(item => item.id === id)
    if (!annotation) return
    setAnnotationEditor(null)
    setAskTarget({ annotationId: annotation.id, page: annotation.page, text: annotation.text, rects: annotation.rects })
    setAiQuestion('')
    setAiError('')
    setMessage('')
  }

  function askAboutSelection() {
    if (!opened) return
    const live = window.getSelection()
    if (live && !live.isCollapsed && live.toString().trim()) captureSelection()
    const snapshot = selectionRef.current
    if (!snapshot?.text) return
    if (snapshot.crossPage || snapshot.page === null || snapshot.rects.length === 0) {
      setMessage('Select text within a single page to ask AI.')
      return
    }
    const existing = annotations.find(item => item.page === snapshot.page && item.text === snapshot.text)
    if (existing) {
      setAskTarget({ annotationId: existing.id, page: existing.page, text: existing.text, rects: existing.rects })
    } else {
      setAskTarget({ annotationId: null, page: snapshot.page, text: snapshot.text, rects: snapshot.rects })
    }
    setAiQuestion('')
    setAiError('')
    setMessage('')
    selectionRef.current = null
    window.getSelection()?.removeAllRanges()
    setSelectedText('')
  }

  async function askPageContext(page: number, passage: string): Promise<string> {
    if (!doc) return ''
    let items = pageTextRef.current.get(page)
    if (!items) {
      const pdfPage = await doc.getPage(page)
      const content = await pdfPage.getTextContent()
      items = content.items.flatMap(item => 'str' in item ? [{ str: item.str, hasEOL: item.hasEOL }] : [])
      pageTextRef.current.set(page, items)
    }
    return buildPageContext(items, passage)
  }

  async function sendAiQuestion() {
    if (!opened || !askTarget || aiBusy) return
    const question = aiQuestion.trim()
    if (!question) return
    if (!aiConfirmed && !window.confirm('Send this passage, its page text, your question, and the earlier messages in this conversation to your configured LLM provider?')) return
    setAiConfirmed(true)
    setAiBusy(true)
    setAiError('')
    try {
      let annotation = askTarget.annotationId ? annotations.find(item => item.id === askTarget.annotationId) : undefined
      if (!annotation) {
        annotation = { id: crypto.randomUUID(), page: askTarget.page, text: askTarget.text, rects: askTarget.rects ?? [] }
        await window.mimosa.saveAnnotation(opened.id, annotation)
        const created = annotation
        setAnnotations(current => current.some(item => item.id === created.id) ? current : [...current, created])
        setAskTarget(current => current ? { ...current, annotationId: created.id } : current)
      }
      const existingMessages = annotation.conversation?.messages ?? []
      const questionMessage = { role: 'user' as const, content: question, at: Date.now() }
      const messagesWithQuestion = [...existingMessages, questionMessage]
      const withQuestion: UnderlineAnnotation = { ...annotation, conversation: { messages: messagesWithQuestion, updatedAt: questionMessage.at } }
      await window.mimosa.saveAnnotation(opened.id, withQuestion)
      setAnnotations(current => current.map(item => item.id === withQuestion.id ? withQuestion : item))
      setAiQuestion('')
      const context = await askPageContext(askTarget.page, askTarget.text)
      const answer = await window.mimosa.askPassage({
        passage: askTarget.text,
        page: askTarget.page,
        context,
        question,
        history: existingMessages.slice(-20).map(({ role, content }) => ({ role, content }))
      })
      const answerMessage = { role: 'assistant' as const, content: answer, at: Date.now() }
      // The underline or conversation may have been deleted while the request
      // was in flight; never recreate either one with a late answer.
      const latest = annotationsRef.current.find(item => item.id === withQuestion.id)
      if (!latest?.conversation) return
      const withAnswer: UnderlineAnnotation = { ...latest, conversation: { messages: [...messagesWithQuestion, answerMessage], updatedAt: answerMessage.at } }
      await window.mimosa.saveAnnotation(opened.id, withAnswer)
      setAnnotations(current => current.map(item => item.id === withAnswer.id ? withAnswer : item))
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'The AI request failed.')
    } finally {
      setAiBusy(false)
    }
  }

  async function deleteAiConversation() {
    if (!opened || !askTarget?.annotationId) return
    const annotation = annotations.find(item => item.id === askTarget.annotationId)
    if (!annotation?.conversation) return
    const next: UnderlineAnnotation = { ...annotation }
    delete next.conversation
    try {
      await window.mimosa.saveAnnotation(opened.id, next)
      setAnnotations(current => current.map(item => item.id === next.id ? next : item))
      setMessage('Conversation deleted.')
    } catch {
      setAiError('Could not delete this conversation.')
    }
  }

  function persistAiWidth() {
    try { localStorage.setItem(AI_WIDTH_KEY, String(aiWidthRef.current)) } catch { /* Storage can be unavailable; the width still applies for this session. */ }
  }

  function startAiResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    const target = event.currentTarget
    const startX = event.clientX
    const startWidth = aiWidthRef.current
    const body = target.closest('.reader-body') as HTMLElement | null
    const maxWidth = Math.max(MIN_AI_WIDTH, Math.min(MAX_AI_WIDTH, (body?.clientWidth ?? MAX_AI_WIDTH + 320) - 320))
    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(Math.min(maxWidth, Math.max(MIN_AI_WIDTH, startWidth + startX - moveEvent.clientX)))
      if (next === aiWidthRef.current) return
      aiWidthRef.current = next
      setAiWidth(next)
    }
    const finish = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', finish)
      target.removeEventListener('pointercancel', finish)
      persistAiWidth()
    }
    target.setPointerCapture(event.pointerId)
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', finish)
    target.addEventListener('pointercancel', finish)
  }

  function resizeAiWidth(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = Math.min(MAX_AI_WIDTH, Math.max(MIN_AI_WIDTH, aiWidthRef.current + (event.key === 'ArrowLeft' ? 20 : -20)))
    aiWidthRef.current = next
    setAiWidth(next)
    persistAiWidth()
  }

  function goToPage(value: number) {
    if (!doc) return
    const target = Math.min(Math.max(1, Math.trunc(value)), doc.numPages)
    pendingAnchorRef.current = null
    setActivePage(target)
    setPageDraft(String(target))
    const reader = readerRef.current
    if (reader && layout.length > 0) reader.scrollTop = layoutOffsetFor(layout, target, 0)
  }

  // Keep a stable handle for the document-scoped link resolver below.
  goToPageRef.current = goToPage

  // Resolves an embedded link against the document that is open *now*. A newer
  // click, Home, or a freshly opened document bumps the request counter and the
  // document ref, so a slow earlier resolution can never move the reader.
  const navigateToDestination = useCallback(async (destination: LinkDestination) => {
    const target = currentDocRef.current
    if (!target) return
    const request = ++navigationRequestRef.current
    try {
      const page = await resolveDestinationPage(target, destination)
      if (request !== navigationRequestRef.current || currentDocRef.current !== target) return
      if (page === null) { setMessage('This link points to an invalid target.'); return }
      setMessage('')
      goToPageRef.current(page)
    } catch (error) {
      if (request !== navigationRequestRef.current || currentDocRef.current !== target) return
      console.error('Could not resolve the PDF link.', error)
      setMessage('Could not open this PDF link. Please try again.')
    }
  }, [])

  function commitPageDraft() {
    if (!doc) return
    const parsed = Number.parseInt(pageDraft, 10)
    if (!Number.isFinite(parsed)) { setPageDraft(String(activePage)); return }
    goToPage(parsed)
  }

  function zoomBy(delta: number) {
    const next = Math.round(Math.min(2.5, Math.max(.6, scale + delta)) * 100) / 100
    if (next === scale) return
    const reader = readerRef.current
    if (reader && layout.length > 0) pendingAnchorRef.current = layoutAnchorAt(layout, reader.scrollTop)
    setScale(next)
  }

  const captureSelection = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const text = selection.toString().trim()
    if (!text) return
    const range = selection.getRangeAt(0)
    const reader = readerRef.current
    const pages = new Set<number>()
    reader?.querySelectorAll<HTMLElement>('[data-page] .text-layer').forEach(layer => {
      if (!range.intersectsNode(layer)) return
      const wrapper = layer.closest<HTMLElement>('[data-page]')
      const page = Number(wrapper?.dataset.page)
      if (Number.isFinite(page)) pages.add(page)
    })
    const pageNumbers = [...pages]
    if (pageNumbers.length === 1) {
      const layer = reader?.querySelector<HTMLElement>(`[data-page="${pageNumbers[0]}"] .text-layer`)
      const layerRect = layer?.getBoundingClientRect()
      const rects: Rect[] = layer && layerRect && layerRect.width > 0 && layerRect.height > 0
        ? [...range.getClientRects()]
          .filter(rect => rect.width > 0 && rect.height > 0)
          .map(rect => ({
            x: (rect.left - layerRect.left) / layerRect.width,
            y: (rect.top - layerRect.top) / layerRect.height,
            width: rect.width / layerRect.width,
            height: rect.height / layerRect.height
          }))
        : []
      selectionRef.current = { text, page: pageNumbers[0], crossPage: false, rects }
    } else {
      selectionRef.current = { text, page: null, crossPage: pageNumbers.length > 1, rects: [] }
    }
    setSelectedText(text)
  }, [])

  // Track DOM selection changes so keyboard and programmatic selections are
  // captured, but ignore empty changes caused by focus moving to the toolbar.
  useEffect(() => {
    let frame = 0
    const handleSelectionChange = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; captureSelection() })
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [captureSelection])

  function readerMouseUp(event: React.MouseEvent) {
    // Clicking an underline opens the comment editor; do not let the reader
    // clear the captured selection for that interaction.
    if (event.target instanceof Element && event.target.closest('[data-annotation-id]')) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      selectionRef.current = null
      setSelectedText('')
      return
    }
    captureSelection()
  }

  async function underline() {
    if (!opened) return
    const live = window.getSelection()
    if (live && !live.isCollapsed && live.toString().trim()) captureSelection()
    const snapshot = selectionRef.current
    if (!snapshot?.text) return
    if (snapshot.crossPage) { setMessage('Select text within a single page to underline.'); return }
    if (snapshot.page === null || snapshot.rects.length === 0) { setMessage('Select text inside a page to underline.'); return }
    const annotation: UnderlineAnnotation = { id: crypto.randomUUID(), page: snapshot.page, text: snapshot.text, rects: snapshot.rects }
    try {
      await window.mimosa.saveAnnotation(opened.id, annotation)
      setAnnotations(current => [...current, annotation])
      selectionRef.current = null
      window.getSelection()?.removeAllRanges()
      setSelectedText('')
      setMessage('Underline saved.')
    } catch { setMessage('Could not save this underline.') }
  }

  async function translate() {
    const live = window.getSelection()
    if (live && !live.isCollapsed && live.toString().trim()) captureSelection()
    const text = live && !live.isCollapsed ? live.toString().trim() : selectedText
    if (!text) return
    if (!translationConfirmed && !window.confirm('Send only the selected text to your configured LLM provider for translation?')) return
    setTranslationConfirmed(true)
    const target = /[\u4e00-\u9fff]/.test(text) ? 'en' : 'zh'
    try { setTranslation(await window.mimosa.translate(text, target)); setMessage('') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Translation failed.') }
  }

  const editingAnnotation = opened && annotationEditor ? annotations.find(item => item.id === annotationEditor.id) ?? null : null
  const aiAnnotation = askTarget?.annotationId ? annotations.find(item => item.id === askTarget.annotationId) ?? null : null

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">M</span><strong>Mimosa</strong><span className="divider" />{opened ? <span className="filename">{opened.name}</span> : <span className="subtle">PDF reader for work</span>}</div>
      <div className="top-actions">{doc && <button className="button secondary" disabled={opening} onClick={() => void goHome()}>Home</button>}<button className="button secondary" onClick={() => setSettingsOpen(true)}>Settings</button><button className="button primary" disabled={opening} onClick={() => void openPdf()}>Open PDF</button></div>
    </header>
    {doc ? <><nav className="toolbar">
      <button className="icon-button" aria-label="Previous page" disabled={activePage <= 1} onClick={() => goToPage(activePage - 1)}>‹</button><label className="page-control"><input aria-label="Page number" type="text" inputMode="numeric" pattern="[0-9]*" value={pageDraft} onFocus={() => setEditingPage(true)} onChange={event => setPageDraft(event.target.value.replace(/[^0-9]/g, ''))} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); commitPageDraft(); event.currentTarget.blur() }
        else if (event.key === 'Escape') { skipBlurCommitRef.current = true; setPageDraft(String(activePage)); event.currentTarget.blur() }
      }} onBlur={() => {
        setEditingPage(false)
        if (skipBlurCommitRef.current) { skipBlurCommitRef.current = false; setPageDraft(String(activePage)); return }
        commitPageDraft()
      }} /><span>/ {doc.numPages}</span></label><button className="icon-button" aria-label="Next page" disabled={activePage >= doc.numPages} onClick={() => goToPage(activePage + 1)}>›</button><span className="tool-separator" /><button className="icon-button" aria-label="Zoom out" onClick={() => zoomBy(-.15)}>−</button><span className="zoom-value">{Math.round(scale * 100)}%</span><button className="icon-button" aria-label="Zoom in" onClick={() => zoomBy(.15)}>+</button><span className="tool-separator" /><input className="search-input" aria-label="Search document" placeholder="Search in document…" value={query} onChange={event => setQuery(event.target.value)} /><button className="icon-button search-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button><span className="toolbar-spacer" />{selectedText && <><button className="button secondary" onClick={askAboutSelection}>Ask AI</button><button className="button secondary" onClick={() => void underline()}>Underline</button><button className="button secondary" onClick={() => void translate()}>Translate</button></>}
    </nav><div className="reader-body">{outline.length > 0 && <OutlineSidebar items={outline} activePage={activePage} onNavigate={goToPage} />}<section ref={readerRef} className="reader" data-active-page={activePage} onMouseUp={readerMouseUp}><div className="page-stack" style={{ paddingBottom: Math.max(0, readerHeight - (layout[layout.length - 1]?.height ?? 0)) }}>{layout.map(entry => <PageView key={entry.page} doc={doc} entry={entry} scale={scale} query={query} annotations={annotations} readerRef={readerRef} onEditAnnotation={openAnnotationEditor} onInternalLink={navigateToDestination} onRenderError={handleRenderError} />)}</div></section>{askTarget && <AiPanel page={askTarget.page} passage={askTarget.text} conversation={aiAnnotation?.conversation} question={aiQuestion} width={aiWidth} busy={aiBusy} error={aiError} onQuestionChange={setAiQuestion} onSend={() => void sendAiQuestion()} onDeleteConversation={() => void deleteAiConversation()} onClose={() => { setAskTarget(null); setAiError('') }} onResizeStart={startAiResize} onResizeKeyDown={resizeAiWidth} />}</div></> : <section className="welcome"><div className="welcome-card"><div className="welcome-icon">M</div><p className="eyebrow">A calmer way to read</p><h1>Make room for<br /><em>deep reading.</em></h1><p className="welcome-copy">Your documents, your notes, your pace.<br />Everything stays on your Mac.</p><button className="button primary large" disabled={opening} onClick={() => void openPdf()}>Open a PDF <span>→</span></button><div className="welcome-foot"><span className="status-dot" />Private by design <span className="foot-divider">·</span> No account required</div><RecentDocuments documents={recent} loading={recentLoading} error={recentError} issues={recentIssues} busy={opening} onOpen={id => void openRecentDocument(id)} onLocate={id => void locateRecentDocument(id)} onRetry={() => void refreshRecent()} /></div></section>}
    {message && <div role="status" className="toast">{message}<button onClick={() => setMessage('')} aria-label="Dismiss">×</button></div>}
    {translation && <aside className="translation-card"><div className="card-heading"><span>Translation</span><button onClick={() => setTranslation('')} aria-label="Close translation">×</button></div><p className="source-text">{selectedText}</p><p>{translation}</p></aside>}
    {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} onSaved={() => setMessage('AI settings saved securely.')} />}
    {editingAnnotation && <AnnotationEditor annotation={editingAnnotation} onSaveComment={comment => saveAnnotationComment(editingAnnotation, comment)} onDelete={() => deleteUnderline(editingAnnotation.id)} onAskAI={() => askAboutAnnotation(editingAnnotation.id)} onClose={() => setAnnotationEditor(null)} />}
    <span className="sr-only">{annotations.length} underline annotations saved</span>
  </main>
}

function Settings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [endpoint, setEndpoint] = useState('https://api.openai.com/v1/')
  const [model, setModel] = useState('')
  const [key, setKey] = useState('')
  const [configured, setConfigured] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void window.mimosa.getTranslationSettings().then(settings => {
      if (settings) { setEndpoint(settings.endpoint); setModel(settings.model); setConfigured(settings.configured) }
    }).catch(() => setError('Could not load AI settings.'))
  }, [])
  async function save(event: React.FormEvent) {
    event.preventDefault()
    try { await window.mimosa.setTranslationSettings({ endpoint, model }, key); onSaved(); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save settings.') }
  }
  async function clear() {
    try { await window.mimosa.clearTranslationSettings(); setConfigured(false); setKey(''); setModel(''); setError('AI settings removed.') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not remove settings.') }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><form className="settings-modal" onSubmit={event => void save(event)}><div className="modal-top"><div><p className="eyebrow">OPTIONAL · TRANSLATION &amp; ASK AI</p><h2>AI settings</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="Close">×</button></div><p className="settings-note">Translation sends the text you select. Ask AI also sends the page text around your passage and the saved conversation. Your key is stored securely on this Mac.</p><label>API endpoint<input required type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label><label>Model<input required value={model} onChange={event => setModel(event.target.value)} placeholder="e.g. gpt-4o-mini" /></label><label>API key<input required={!configured} type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} placeholder={configured ? 'Saved securely — enter a new key to replace' : ''} /></label>{error && <p className="form-error">{error}</p>}<div className="modal-actions">{configured && <button type="button" className="button secondary" onClick={() => void clear()}>Remove key</button>}<button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary">Save securely</button></div></form></div>
}
