import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import type { Plugin } from 'vite'

const developmentCsp: Plugin = {
  name: 'development-csp',
  transformIndexHtml(html) {
    return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self' http://127.0.0.1:*", "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*")
  }
}

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), developmentCsp, viteStaticCopy({ targets: [
    { src: '../../node_modules/pdfjs-dist/cmaps/*', dest: 'cmaps', rename: { stripBase: true } },
    { src: '../../node_modules/pdfjs-dist/standard_fonts/*', dest: 'standard_fonts', rename: { stripBase: true } }
  ] })],
  base: './',
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { strictPort: true }
})
