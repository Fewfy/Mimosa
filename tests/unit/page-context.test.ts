import { describe, expect, it } from 'vitest'
import { buildPageContext } from '../../src/renderer/page-context'

describe('buildPageContext', () => {
  it('keeps the passage and text around it on the same page', () => {
    const context = buildPageContext([
      { str: 'Reviewers often hold many small decisions at once.' },
      { str: 'The working memory cost of a review grows with unstated assumptions.' },
      { str: 'Short, well-scoped reviews finish faster than long, vague ones.' }
    ], 'working memory cost of a review')
    expect(context).toContain('Reviewers often hold many small decisions')
    expect(context).toContain('The working memory cost of a review')
    expect(context).toContain('Short, well-scoped reviews')
  })

  it('matches a passage split across text items and whitespace', () => {
    const context = buildPageContext([
      { str: 'The working' },
      { str: 'memory cost grows with' },
      { str: 'unstated assumptions.' }
    ], 'working memory cost grows with unstated')
    expect(context).toContain('The working memory cost grows with unstated assumptions.')
  })

  it('caps the returned context around the passage', () => {
    const before = `Before ${'a'.repeat(200)}`
    const after = `After ${'b'.repeat(200)}`
    const context = buildPageContext([
      { str: before },
      { str: 'The focus passage.' },
      { str: after }
    ], 'focus passage', 70)
    expect(context.length).toBeLessThanOrEqual(70)
    expect(context).toContain('focus passage')
  })

  it('falls back to the beginning of the page when the passage cannot be found', () => {
    const context = buildPageContext([{ str: 'A page without that phrase.' }], 'missing passage', 50)
    expect(context).toBe('A page without that phrase.')
  })

  it('returns an empty string for an empty page', () => {
    expect(buildPageContext([], 'anything')).toBe('')
  })
})
