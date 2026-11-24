import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/packaged.spec.ts',
  timeout: 30000,
  use: { headless: true }
})
