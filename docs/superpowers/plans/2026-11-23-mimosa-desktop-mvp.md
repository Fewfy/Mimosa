# Mimosa macOS Desktop MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a macOS-only Electron PDF reader with local reading, persistent underline annotations, English–Chinese LLM translation, and per-document last-page restoration.

**Architecture:** Electron main process owns local file access, secure credential storage, and narrowly scoped IPC. A React/TypeScript renderer uses PDF.js for rendering, search, selection, and annotation overlays. Local metadata is persisted per document; translation sends selected text only after explicit user action to a configured OpenAI-compatible API.

**Tech Stack:** Electron, TypeScript, React, Vite, PDF.js (`pdfjs-dist`), Vitest, Playwright (Electron smoke/integration), macOS Keychain via `safeStorage`.

## Global Constraints

- macOS only for the first version.
- Read PDFs locally; reading, annotations, and position persistence must work offline.
- The source PDF must not be modified by underline annotations.
- Translation supports English to Chinese and Chinese to English only.
- Only explicit translation requests may send selected text to a configured external endpoint.
- Store the LLM API key using macOS secure storage and do not expose it to renderer code or logs.
- Do not log API keys, selected text, or translated output.
- No OCR, whole-document translation, collaboration, cloud synchronization, or additional annotation types.
- Do not distribute until macOS packaging, signing/notarization, and dependency licenses have been reviewed.

---

## File Structure

- `package.json`, `package-lock.json`, `tsconfig*.json`, `vite.config.ts`, `electron-builder.yml`: app scripts, toolchain, packaging.
- `src/main/index.ts`, `src/main/preload.ts`, `src/main/ipc.ts`: Electron lifecycle, secure bridge, main-process handlers.
- `src/main/storage/document-store.ts`: per-document position and annotation persistence.
- `src/main/security/credentials.ts`: API key storage and retrieval using Electron safeStorage.
- `src/main/translation/client.ts`: OpenAI-compatible request and response handling.
- `src/shared/contracts.ts`: validated IPC request/response and persisted record types.
- `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`: renderer bootstrap and top-level layout.
- `src/renderer/components/`: file opening, toolbar, page canvas, search, settings, translation, and annotation UI components.
- `src/renderer/pdf/`: PDF.js loading, rendering, text selection, search, and annotation geometry.
- `src/renderer/hooks/`: document lifecycle and reading-position persistence.
- `tests/unit/`: storage, translation request shaping, and validation tests.
- `tests/e2e/`: packaged Electron flows using controlled fixtures and mocked translation endpoint.

## Task 1: Create a runnable Electron + React project

**Files:** Create the root configuration files and minimal main/preload/renderer entrypoints listed above. Test: `tests/unit/app-config.test.ts` and `tests/e2e/smoke.spec.ts`.

- [x] Initialize npm project with Electron, React, TypeScript, Vite, Vitest, Playwright, and PDF.js dependencies; configure scripts `dev`, `build`, `test`, `test:e2e`, and `package:mac`.
- [x] Add a failing smoke test that launches the development app and asserts the window title is `Mimosa` and the app renders a visible “Open PDF” control.
- [x] Run `npm test -- --run` and `npm run test:e2e`; confirm the smoke test fails because the app shell is not present.
- [x] Add Electron main process with `contextIsolation: true`, `nodeIntegration: false`, and a preload bridge exposing only the methods defined in `src/shared/contracts.ts`.
- [x] Add React shell showing “Mimosa” and “Open PDF”, wired to a native open-file dialog through IPC.
- [x] Run `npm test -- --run`, `npm run build`, and `npm run test:e2e`; expect all to pass on macOS.

## Task 2: Add local PDF opening, rendering, navigation, and search

**Files:** `src/main/ipc.ts`, `src/main/preload.ts`, `src/shared/contracts.ts`, `src/renderer/App.tsx`, `src/renderer/components/PdfReader.tsx`, `src/renderer/components/ReaderToolbar.tsx`, `src/renderer/pdf/document.ts`, `src/renderer/pdf/worker.ts`, `tests/e2e/pdf-reading.spec.ts`, `tests/fixtures/sample-text.pdf`.

- [x] Add an E2E test opening the fixture PDF and asserting page count, page navigation, zoom, and text search result visibility.
- [x] Run `npm run test:e2e -- --grep "opens and navigates"`; verify it fails because PDF loading is not implemented.
- [x] Implement main-process open dialog for PDF files and return a read-only document handle/data through a controlled IPC operation; do not expose arbitrary filesystem APIs to renderer.
- [x] Implement PDF.js loading/rendering, previous/next and page-number navigation, zoom controls, fit-width/page behavior, outline navigation when available, and text-layer search/selection.
- [x] Run the focused E2E test and then `npm run build`; expect the fixture to render and all reading controls to work.

## Task 3: Persist per-document reading position

**Files:** `src/shared/contracts.ts`, `src/main/storage/document-store.ts`, `src/main/ipc.ts`, `src/main/preload.ts`, `src/renderer/hooks/useReadingPosition.ts`, `src/renderer/components/PdfReader.tsx`, `tests/unit/document-store.test.ts`, `tests/e2e/reading-position.spec.ts`.

- [x] Add unit tests for saving/loading page positions, separate identities, missing records, and corrupt store recovery without overwriting valid records.
- [x] Run `npm test -- --run tests/unit/document-store.test.ts`; verify the tests fail before storage implementation.
- [x] Implement document identity as SHA-256 of the opened PDF bytes, computed in the main process; persist page numbers in app user data using an atomic write.
- [x] Implement IPC for loading/updating page position and debounce updates while changing pages; clamp restored pages to the document page count.
- [x] Add E2E test proving a reopened PDF restores its last page and a second PDF starts independently at page one.
- [x] Run `npm test -- --run` and `npm run test:e2e -- --grep "reading position"`; expect tests to pass.

## Task 4: Add persistent underline annotations

**Files:** `src/shared/contracts.ts`, `src/main/storage/document-store.ts`, `src/main/ipc.ts`, `src/main/preload.ts`, `src/renderer/pdf/annotations.ts`, `src/renderer/components/PdfReader.tsx`, `src/renderer/components/AnnotationLayer.tsx`, `tests/unit/annotations.test.ts`, `tests/e2e/underline-annotations.spec.ts`.

- [x] Add unit tests for converting selected text ranges into normalized per-page rectangles, and for associating annotation records with document fingerprint and page.
- [x] Run `npm test -- --run tests/unit/annotations.test.ts`; confirm failures before geometry/persistence implementation.
- [x] Implement selecting text and invoking underline; save selection text, page, and normalized bounding rectangles under the PDF fingerprint. Render overlays when the matching page loads and allow deleting an underline.
- [x] Keep persistence in app user data and ensure there is no write path to the original PDF.
- [x] Add E2E test to underline selected fixture text, close/reopen, and verify overlay remains while fixture bytes are unchanged.
- [x] Run `npm test -- --run` and `npm run test:e2e -- --grep underline`; expect tests to pass.

## Task 5: Add secure LLM settings and English–Chinese translation

**Files:** `src/shared/contracts.ts`, `src/main/security/credentials.ts`, `src/main/translation/client.ts`, `src/main/ipc.ts`, `src/main/preload.ts`, `src/renderer/components/SettingsDialog.tsx`, `src/renderer/components/TranslationPanel.tsx`, `src/renderer/App.tsx`, `tests/unit/translation-client.test.ts`, `tests/unit/credentials.test.ts`, `tests/e2e/translation.spec.ts`.

- [x] Add unit tests for supported language directions, request body, endpoint validation, HTTP failures, malformed responses, and credential storage failure behavior.
- [x] Run `npm test -- --run tests/unit/translation-client.test.ts tests/unit/credentials.test.ts`; confirm failures before implementation.
- [x] Implement settings for API-compatible endpoint and model; store key only via `safeStorage` in the main process and expose set/has/delete operations without returning the key to renderer.
- [x] Implement main-process translation request: validate endpoint protocol and credentials, send selected text only on explicit action, detect English/Chinese direction, prompt for faithful translation only, enforce bounded request size/timeout, parse compatible response, and return actionable errors without sensitive content.
- [x] Show a clear disclosure before the first external translation request; display result next to selection. Without configuration, explain how to configure settings. Do not alter selection on errors.
- [x] Add E2E tests with a local mocked compatible endpoint for EN→ZH and ZH→EN, plus missing-key and provider-error flows; ensure no request occurs until the user invokes translation.
- [x] Run unit tests, translation E2E tests, and `npm run build`; expect all checks to pass.

## Task 6: Finish product flows, security checks, and documentation

**Files:** `README.md`, `electron-builder.yml`, `tests/e2e/offline-and-security.spec.ts`, relevant application files only as needed.

- [x] Update README setup instructions, macOS prerequisites, development commands, and current feature support; remove “planning stage” language.
- [x] Add E2E test that disables network access and verifies PDF reading, annotations, and last-page restoration still work.
- [x] Review Electron security settings: context isolation enabled, renderer sandbox enabled where compatible, restrictive content security policy, no remote module, no arbitrary IPC channel, and no endpoint/key/text in logs.
- [x] Run `npm test -- --run`, `npm run test:e2e`, `npm run build`, and `npm run package:mac` on macOS; record outputs and fix failures.
- [x] Verify generated macOS package opens, loads a local PDF, and leaves its bytes unchanged after annotation.
- [x] Review dependency licenses and document signing/notarization and update requirements before any distribution.

## Spec Coverage Self-Review

- Local PDF reading, navigation, zoom, search, selection, outline, and scanned-PDF limitation: Task 2.
- Persistent underlines, delete behavior, document association, and preserving original files: Task 4.
- Explicit EN↔ZH translation, API settings, secure key storage, error paths, and no network call before action: Task 5.
- Per-document last-page restore, matching identity, offline behavior: Task 3 and Task 6.
- macOS-only Electron app, security boundaries, release considerations: Tasks 1 and 6.
- Open design decisions: validate endpoint compatibility and annotation geometry in Tasks 4–5; fingerprint strategy in Task 3; page-only position chosen for initial version; distribution gates in Task 6.
