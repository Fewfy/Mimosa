import { describe, expect, it } from 'vitest'
import { pdfAssetUrls } from '../../src/renderer/pdf-assets'

describe('pdfAssetUrls', () => {
  it('resolves assets relative to the packaged renderer document', () => {
    const urls = pdfAssetUrls('file:///Applications/Mimosa.app/Contents/Resources/app.asar/dist/index.html')
    expect(urls.cMapUrl).toBe('file:///Applications/Mimosa.app/Contents/Resources/app.asar/dist/cmaps/')
    expect(urls.standardFontDataUrl).toBe('file:///Applications/Mimosa.app/Contents/Resources/app.asar/dist/standard_fonts/')
  })

  it('resolves assets from the development server root', () => {
    const urls = pdfAssetUrls('http://127.0.0.1:5173/')
    expect(urls.cMapUrl).toBe('http://127.0.0.1:5173/cmaps/')
    expect(urls.standardFontDataUrl).toBe('http://127.0.0.1:5173/standard_fonts/')
  })
})
