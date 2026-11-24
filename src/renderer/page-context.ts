export type PageTextItem = { str: string; hasEOL?: boolean }

/**
 * Builds a whitespace-insensitive window around the passage so a selection that
 * spans PDF text items still matches. The caller sends the passage separately,
 * so this only needs to supply enough surrounding text to resolve references.
 */
export function buildPageContext(items: PageTextItem[], passage: string, maxChars = 6_000): string {
  if (items.length === 0 || maxChars <= 0) return ''
  const text = items.map(item => `${item.str}${item.hasEOL ? '\n' : ''}`).join(' ')
  const compactPassage = compact(passage)
  if (!compactPassage) return clip(text, maxChars)

  let compactText = ''
  const offsets: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (/\s/.test(character)) continue
    compactText += character
    offsets.push(index)
  }
  const match = compactText.indexOf(compactPassage)
  if (match < 0) return clip(text, maxChars)

  const start = offsets[match]
  const end = offsets[match + compactPassage.length - 1] + 1
  const passageLength = end - start
  const windowStart = passageLength >= maxChars
    ? start
    : Math.max(0, Math.min(start - Math.floor((maxChars - passageLength) / 2), text.length - maxChars))
  const windowEnd = Math.min(text.length, windowStart + maxChars)
  return text.slice(windowStart, windowEnd).replace(/\s+/g, ' ').trim()
}

function compact(value: string): string {
  return value.replace(/\s+/g, '')
}

function clip(text: string, maxChars: number): string {
  return text.slice(0, maxChars).replace(/\s+/g, ' ').trim()
}
