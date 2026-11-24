export function pdfAssetUrls(base: string) {
  return {
    cMapUrl: new URL('cmaps/', base).toString(),
    standardFontDataUrl: new URL('standard_fonts/', base).toString()
  }
}
