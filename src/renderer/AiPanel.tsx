import { useEffect, useRef } from 'react'
import type { PassageConversation } from '../shared/contracts'

type AiPanelProps = {
  page: number
  passage: string
  conversation: PassageConversation | undefined
  question: string
  width: number
  busy: boolean
  error: string
  onQuestionChange: (value: string) => void
  onSend: () => void
  onDeleteConversation: () => void
  onClose: () => void
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
}

export function AiPanel({
  page, passage, conversation, question, width, busy, error,
  onQuestionChange, onSend, onDeleteConversation, onClose, onResizeStart, onResizeKeyDown
}: AiPanelProps) {
  const messagesRef = useRef<HTMLDivElement>(null)
  const messages = conversation?.messages ?? []

  useEffect(() => {
    const node = messagesRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.length, busy])

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    if (question.trim() && !busy) onSend()
  }

  return <aside className="ai-panel" aria-label="Ask AI" style={{ width }}>
    <div
      className="ai-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize AI panel"
      aria-valuemin={300}
      aria-valuemax={720}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={onResizeStart}
      onKeyDown={onResizeKeyDown}
    />
    <div className="ai-panel-inner">
      <header className="ai-head">
        <div>
          <p className="eyebrow">ASK AI · PAGE {page}</p>
          <h2>About this passage</h2>
        </div>
        <button type="button" className="close-button" aria-label="Close Ask AI" onClick={onClose}>×</button>
      </header>
      <p className="ai-quote">{passage}</p>
      {messages.length > 0 && <div className="ai-tools">
        <button type="button" className="ai-delete" disabled={busy} onClick={onDeleteConversation}>Delete conversation</button>
      </div>}
      <div className="ai-messages" ref={messagesRef} aria-live="polite">
        {messages.length === 0 && !busy && <p className="ai-empty">Ask a question about this passage. Follow-ups stay with it.</p>}
        {messages.map((message, index) => <div className={`ai-message ${message.role}`} key={`${message.at}-${index}`}>
          <span className="ai-role">{message.role === 'user' ? 'You' : 'AI'}</span>
          <p>{message.content}</p>
        </div>)}
        {busy && <div className="ai-thinking">Thinking…</div>}
      </div>
      {error && <p className="ai-error" role="alert">{error}</p>}
      <div className="ai-composer">
        <textarea
          aria-label="Question about this passage"
          value={question}
          maxLength={4_000}
          rows={2}
          autoFocus
          disabled={busy}
          placeholder="Ask about this passage… (Enter to send)"
          onChange={event => onQuestionChange(event.target.value)}
          onKeyDown={handleComposerKeyDown}
        />
        <button type="button" className="button primary" disabled={busy || !question.trim()} onClick={onSend}>Send</button>
      </div>
    </div>
  </aside>
}
