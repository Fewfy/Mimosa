import type { RecentDocument } from '../shared/contracts'

type RecentDocumentsProps = {
  documents: RecentDocument[]
  loading: boolean
  error: string
  issues: Record<string, 'missing' | 'changed'>
  busy: boolean
  onOpen: (id: string) => void
  onLocate: (id: string) => void
  onRetry: () => void
}

/** Homepage list of previously opened PDFs, newest first as stored. */
export function RecentDocuments({ documents, loading, error, issues, busy, onOpen, onLocate, onRetry }: RecentDocumentsProps) {
  return <section className="recent" aria-labelledby="recent-heading">
    <h2 id="recent-heading" className="recent-heading">Recent documents</h2>
    {loading && documents.length === 0 ? <p className="recent-status" aria-live="polite">Loading recent documents…</p> : null}
    {error ? <div className="recent-error">
      <p>{error}</p>
      <button type="button" className="button secondary" disabled={busy} onClick={onRetry}>Retry</button>
    </div> : null}
    {documents.length > 0 ? <ul className="recent-list">
      {documents.map(document => {
        const openedAt = new Date(document.lastOpenedAt)
        const validDate = !Number.isNaN(openedAt.valueOf())
        const issue = issues[document.id]
        return <li className="recent-row" key={document.id}>
          <button
            type="button"
            className="recent-item"
            aria-label={document.name}
            data-document-id={document.id}
            disabled={busy}
            onClick={() => onOpen(document.id)}
          >
            <span className="recent-name">{document.name}</span>
            <time
              className="recent-date"
              dateTime={validDate ? openedAt.toISOString() : undefined}
              data-last-opened-at={document.lastOpenedAt}
            >{validDate ? openedAt.toLocaleString(undefined, {
              year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            }) : 'Unknown date'}</time>
          </button>
          {issue ? <div className="recent-issue" data-status={issue}>
            <span>{issue === 'missing'
              ? 'This file is missing from its saved location.'
              : 'This file has changed since it was last opened.'}</span>
            <button
              type="button"
              className="button secondary"
              aria-label={`Locate ${document.name}`}
              disabled={busy}
              onClick={() => onLocate(document.id)}
            >Locate…</button>
          </div> : null}
        </li>
      })}
    </ul> : null}
    {!loading && !error && documents.length === 0 ? <p className="recent-status">No recent documents yet.</p> : null}
  </section>
}
