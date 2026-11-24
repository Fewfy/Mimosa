# Mimosa

A focused PDF reader for everyday work.

Mimosa helps people read, annotate, translate, and return to work documents without losing context. It is intended for technical specifications, research papers, reports, manuals, and other PDF-based materials used during the workday.

## Product status

Mimosa is an early macOS desktop application. It currently supports local PDF reading, page navigation, document outlines, zoom, text search and selection, app-local underline annotations, last-page restoration, optional English–Chinese translation, and saved Ask AI conversations about underlined passages through a user-configured OpenAI-compatible API.

## Product goals

- **Read with focus:** Keep the document central and make common reading actions easy to reach.
- **Capture useful context:** Let users mark important passages while reading.
- **Remove language barriers:** Provide English–Chinese translation when the user supplies an LLM key.
- **Resume quickly:** Restore each document to the position where the user last stopped reading.
- **Protect work content:** Make external processing explicit and avoid sending document content to an LLM unless the user has configured translation or Ask AI.

## Core functionality

### 1. Read PDF documents

Users can open a local PDF and read it page by page.

The reader provides these controls:

- Open a local PDF file.
- Move to the previous or next page or enter a page number.
- Zoom in and out.
- Search text on the current page.
- Select and copy text when the PDF permits text selection.

Scanned PDFs remain viewable, but search, selection, underlining, and translation require extractable text. When a PDF includes an outline, Mimosa displays its entries in a sidebar for direct page navigation. Fit-to-page and fit-to-width views are not yet available.

### 2. Take notes with underline

Users can underline selected text to record important passages while reading.

Current behavior:

- Select text and apply an underline annotation.
- Display the underline consistently when the user revisits the page.
- Keep annotations associated with the document and page where they were created.
- Allow the user to remove an underline.
- Preserve annotations when the document is closed and reopened.

Underlines are stored locally in Mimosa and do not modify the source PDF. Click an underline to add a comment, ask AI about it, or remove it. Free-form text boxes, drawing tools, and highlights are not included.

### 3. English–Chinese translation with an LLM key

Users can configure an OpenAI-compatible API endpoint, model, and API key to translate selected PDF text. Translation is optional and not required for normal PDF reading.

Initial language support:

- English to Chinese.
- Chinese to English.

Current behavior:

1. The user selects text in the PDF.
2. The user chooses Translate; the first request prompts the user to confirm external processing.
3. Mimosa sends only the selected text to the configured LLM provider.
4. The translated result is shown in the app without changing the source document.

If no LLM key is configured, the translation action should explain that configuration is required while leaving reading and underline annotations available. If the provider request fails, Mimosa should show an actionable error and keep the original selected text intact.

Selected text is sent only after the user confirms the first translation request. API keys are encrypted with Electron safeStorage on macOS. Text PDFs support selection-based translation; scanned PDFs require OCR, which is not currently included.

### 4. Ask AI about a passage

Users can ask the configured LLM provider questions about a passage while reading.

Current behavior:

1. The user selects text or opens an existing underline and chooses Ask AI.
2. A resizable right-hand panel quotes the passage and accepts a question.
3. The first request prompts the user to confirm external processing. The prompt explains that the passage, the same page's text around it, and the saved conversation are sent.
4. The question and answer are saved locally with the underline and restored when the document is reopened.
5. Asking about a temporary selection saves that selection as an underline when the first question is sent.
6. The user can delete the conversation while keeping the underline, or delete the underline and its conversation together.

Ask AI shares the endpoint, model, and API key configured for translation. It sends the passage, same-page context, the current question, and earlier messages in the conversation, but not the whole document. Requests time out after 60 seconds, and failures leave the saved question and underline in place.

### 5. Remember the last reading position

Mimosa remembers the last reading position separately for each PDF.

Current behavior:

- Save the current page as the user reads.
- Restore the saved page when the same PDF is opened again.
- Restore the position only for the matching document, not for every PDF globally.
- If a document has moved, changed, or can no longer be identified reliably, reopen it at a safe default position rather than applying an incorrect position.
- Saving the reading position must not require an LLM key or network access.

The app currently restores the last page for the same PDF file. Position is matched using the document's SHA-256 content fingerprint.

## Out of scope for the first version

- Translation languages other than English and Chinese.
- Automatic translation of an entire document.
- Cloud document synchronization.
- Collaborative annotations.
- Full text editing or PDF modification beyond underline annotations.
- Built-in OCR for scanned documents.
- A bundled LLM service or API key.

## Privacy and data handling

Work PDFs may contain confidential information. Mimosa should follow these rules:

- Local reading, underline annotations, and reading-position persistence should work without a network connection.
- Translation and Ask AI are the initial features that send text to an external LLM provider.
- The user must provide and control the LLM key.
- The app asks before the first translation or Ask AI request. Translation sends only the selected text; Ask AI sends the passage, the same page's text around it, the current question, and earlier messages in that conversation.
- API keys, selected text, page context, questions, answers, and translations are not written to application logs.
- Conversations are stored locally with their underline annotations in Mimosa's document store.
- API endpoint and model settings are saved locally; the API key is encrypted with Electron safeStorage.
- Translation and Ask AI require network access; PDF reading, notes, and reading-position persistence do not.

## Acceptance criteria

The first usable version is ready for review when a user can:

1. Open a local PDF and read it with page navigation and zoom controls.
2. Select text, underline it, close the document, reopen it, and still see the underline.
3. Configure an LLM key, select English or Chinese text, and receive a translation in the other language.
4. Open a document, move to a different page, close it, reopen it, and return to the last page.
5. Use reading and underline annotations without configuring an LLM key.
6. Ask AI about a selected passage or underline, receive an answer, reopen the document, and find the saved conversation.
7. Delete a conversation without removing its underline, or delete both together.
8. Receive a clear failure message when translation or Ask AI is unavailable or the provider request fails.

## Getting started

### Requirements

- macOS 12 or later.
- Node.js 22.12 or later and npm for development.

### Run in development

```sh
npm install
npm run dev
```

### Build and test

```sh
npm test -- --run
npm run build
npm run package:mac
```

The macOS package is written to `release/`. Builds are currently unsigned; macOS may warn when opening them. A trusted Developer ID certificate and notarization are required before distributing the app.

## Current limitations

- App-local annotations are visible only in Mimosa; they are not embedded in the PDF.
- Last reading position stores the page number, not the scroll offset.
- Search currently highlights matching text spans on the current page.
- Translation and Ask AI require an OpenAI-compatible Chat Completions endpoint and a model name; provider-specific variants may not be compatible.
- Ask AI sends a capped amount of same-page text, not the whole document, and does not support streaming responses.
- No OCR, cloud sync, or multi-platform support.
