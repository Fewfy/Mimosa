import { useEffect, useRef, useState } from 'react'
import type { UnderlineAnnotation } from '../shared/contracts'

type AnnotationEditorProps = {
  annotation: UnderlineAnnotation
  onSaveComment: (comment: string | undefined) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
}

/**
 * Accessible modal for a single underline annotation. Saving and deletion are
 * owned by the parent so the persisted state changes before this UI changes;
 * failures keep the modal and the draft in place.
 */
export function AnnotationEditor({ annotation, onSaveComment, onDelete, onClose }: AnnotationEditorProps) {
  const [draft, setDraft] = useState(annotation.comment ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const field = textareaRef.current
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }, [])

  async function commit(comment: string | undefined) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onSaveComment(comment)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save this comment.')
    } finally {
      setBusy(false)
    }
  }

  async function removeUnderline() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onDelete()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove this underline.')
    } finally {
      setBusy(false)
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (!busy) onClose()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)')]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  return <div
    className="modal-backdrop"
    role="presentation"
    onKeyDown={handleKeyDown}
    onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}
  >
    <div ref={dialogRef} className="settings-modal annotation-modal" role="dialog" aria-modal="true" aria-labelledby="annotation-editor-title">
      <div className="modal-top">
        <div>
          <p className="eyebrow">UNDERLINE</p>
          <h2 id="annotation-editor-title">Underline comment</h2>
        </div>
        <button type="button" className="close-button" onClick={onClose} aria-label="Close" disabled={busy}>×</button>
      </div>
      <p className="annotation-quote">{annotation.text}</p>
      <label>Comment<textarea
        ref={textareaRef}
        value={draft}
        disabled={busy}
        placeholder="Add a note for this passage…"
        onChange={event => setDraft(event.target.value)}
      /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions annotation-actions">
        <button type="button" className="button danger annotation-delete" disabled={busy} onClick={() => void removeUnderline()}>Delete underline</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void commit(undefined)}>Remove comment</button>
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="button primary" disabled={busy} onClick={() => {
          const comment = draft.trim()
          void commit(comment ? comment : undefined)
        }}>Save comment</button>
      </div>
    </div>
  </div>
}
