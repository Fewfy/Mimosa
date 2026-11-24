export async function translateText(endpoint: string, model: string, key: string, text: string, target: 'en' | 'zh'): Promise<string> {
  const url = new URL(endpoint)
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) || url.username || url.password) {
    throw new Error('Use an HTTPS endpoint without embedded credentials.')
  }
  if (text.length === 0 || text.length > 12000) throw new Error('Select text between 1 and 12,000 characters to translate.')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(new URL('chat/completions', endpoint.endsWith('/') ? endpoint : `${endpoint}/`), {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: `Translate the user's text faithfully into ${target === 'zh' ? 'Simplified Chinese' : 'English'}. Return only the translation.` },
          { role: 'user', content: text }
        ]
      }),
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`Translation provider returned HTTP ${response.status}. Check the endpoint, model, and API key.`)
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const result = payload.choices?.[0]?.message?.content
    if (typeof result !== 'string' || result.length === 0) throw new Error('Translation provider returned an unsupported response.')
    return result
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Translation request timed out.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
