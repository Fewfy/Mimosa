import type { OutlineItem } from './pdf-outline'

type OutlineProps = {
  items: OutlineItem[]
  activePage: number
  onNavigate: (page: number) => void
}

export function OutlineSidebar({ items, activePage, onNavigate }: OutlineProps) {
  return <aside className="outline-sidebar">
    <nav aria-label="Document outline">
      <p className="outline-heading">Contents</p>
      <OutlineList items={items} activePage={activePage} onNavigate={onNavigate} />
    </nav>
  </aside>
}

function OutlineList({ items, activePage, onNavigate }: OutlineProps) {
  return <ul className="outline-list">
    {items.map((item, index) => {
      // A local `const` keeps `page` narrowed to `number` in the click handler.
      const { title, page, bold, italic, children } = item
      return <li className="outline-item" key={`${title}-${index}`}>
        {page === null ? <span className="outline-label">{title}</span> : <button
          type="button"
          className="outline-label"
          aria-current={page === activePage ? 'page' : undefined}
          data-outline-title={title}
          onClick={() => onNavigate(page)}
          style={{ fontWeight: bold ? 700 : undefined, fontStyle: italic ? 'italic' : undefined }}
        >{title}</button>}
        {children.length > 0 && <OutlineList items={children} activePage={activePage} onNavigate={onNavigate} />}
      </li>
    })}
  </ul>
}
