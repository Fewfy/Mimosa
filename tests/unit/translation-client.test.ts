import { afterEach, describe, expect, it, vi } from 'vitest'
import { translateText } from '../../src/main/translation/client'

afterEach(() => vi.unstubAllGlobals())

describe('translateText', () => {
  it('sends selected text and explicit target language to compatible endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(translateText('https://example.com/v1/', 'model-x', 'secret', 'Hello', 'zh')).resolves.toBe('你好')
    expect(fetch).toHaveBeenCalledWith(new URL('https://example.com/v1/chat/completions'), expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      body: expect.stringContaining('Hello')
    }))
    expect(fetch.mock.calls[0][1].body).toContain('Simplified Chinese')
  })

  it('rejects insecure endpoints and oversized selection before network calls', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(translateText('http://example.com/v1/', 'model-x', 'secret', 'Hello', 'zh')).rejects.toThrow('HTTPS')
    await expect(translateText('https://example.com/v1/', 'model-x', 'secret', 'x'.repeat(12001), 'zh')).rejects.toThrow('12,000')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns provider errors without leaking selected text or key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive provider body', { status: 401 })))
    await expect(translateText('https://example.com/v1/', 'model-x', 'secret', 'private text', 'en')).rejects.toThrow('HTTP 401')
  })
})
