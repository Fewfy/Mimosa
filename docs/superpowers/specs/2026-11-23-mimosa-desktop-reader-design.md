# Mimosa macOS Desktop Reader — Product Design

**Status:** Proposed for user review  
**Decision owner:** User (to confirm)  
**Requested decision:** Approve the first-version product scope and technical direction before implementation planning.

## Summary

Mimosa is a macOS-only desktop application for reading work PDFs. The first usable version will support local PDF reading, persistent underline annotations stored separately from source files, English–Chinese translation of user-selected text through a user-configured OpenAI-compatible LLM API, and per-document restoration of the last reading page.

The proposed implementation is Electron with TypeScript and React, using PDF.js to render PDFs and expose selectable text. Reading, annotation storage, and position persistence should work offline. Network access is limited to explicit translation requests.

## Background

The repository currently contains product requirements but no application code. Work PDFs may contain confidential information, so reading and notes should remain local, and external transmission must be explicit. The first version is deliberately focused on a small set of reading workflows rather than document management or collaboration.

## Goals

- Open and read local PDF files on macOS.
- Navigate pages, zoom, and use text search, selection, copying, and PDF outlines when available.
- Underline selected text and preserve annotations across app restarts without modifying the original PDF.
- Translate selected text between English and Chinese only when the user requests it and has configured an API key.
- Restore the last reading page separately for each PDF.
- Keep reading, annotations, and position persistence available without network access or an LLM key.

## Non-goals

- Windows or Linux support in the first version.
- OCR for scanned documents, automatic whole-document translation, or translation languages beyond English and Chinese.
- Cloud synchronization, collaborative editing, or a bundled LLM service/key.
- Editing PDF content or adding annotation types beyond underline.
- Guaranteeing that app-local annotations are visible in other PDF readers.

## Proposed design

### Application structure

- **Electron main process:** Own the application window and native file-opening integration. Keep privileged operating-system access out of the renderer.
- **Renderer:** React and TypeScript UI for the document reader, navigation, annotation actions, translation, and settings.
- **PDF.js:** Render local PDFs and provide text selection/search where the PDF contains extractable text.
- **Local persistence:** Store reading positions and underline annotation data in app-managed local storage, keyed by a stable document identity. Preserve the source PDF unchanged.
- **Secure key storage:** Store the user’s LLM API key in macOS Keychain through a narrowly scoped main-process interface. Do not expose the key to the renderer or include it in logs.

These are proposed boundaries; exact libraries and persistence schema belong in the implementation plan.

### PDF reading flow

1. The user opens a local PDF through the app.
2. Mimosa renders the document and restores its saved page if it can identify a matching document; otherwise it opens at the first page.
3. The user navigates by previous/next page, page number, outline, or text search, and adjusts zoom.
4. Mimosa updates the saved page as the user reads.

PDFs without extractable text remain readable, but search, selection-based underlining, copying, and translation may be unavailable.

### Underline annotation flow

1. The user selects text in the rendered PDF.
2. The user invokes the underline action.
3. Mimosa records a page-associated annotation in local app data, including enough positional information to draw it over the selected text when the document is reopened.
4. The user can remove the underline.

Annotations are app-local and do not alter the source PDF. Reassociation behavior when a PDF is replaced or materially changed must avoid displaying an underline at an unrelated location; when identity or placement cannot be trusted, the annotation should not be silently applied to the wrong document content.

### Translation flow

1. The user configures an OpenAI-compatible API endpoint, model, and API key in settings.
2. The user selects text and explicitly requests translation.
3. Mimosa sends only that selected text to the configured endpoint and requests translation to the other supported language (English or Chinese).
4. Mimosa displays the result without changing the PDF or selection.

Translation remains unavailable until configuration is complete. Failures should preserve the selected source text and show a clear, actionable message. The UI must make the external transmission clear before the first request. The provider, endpoint, model, API format compatibility, timeout, and request-size limits need to be finalized before implementation; this design does not assume every provider marketed as OpenAI-compatible behaves identically.

### Reading position

At minimum, Mimosa persists the current page per document and restores it on the next open. Matching should use a stable local document identity, such as a content fingerprint, rather than the file name alone. If the PDF changes, the app should avoid restoring a potentially incorrect position or annotation; the exact identity strategy and fingerprinting cost require implementation-level validation.

## Alternatives and trade-offs

### PDF.js in Electron (recommended)

Provides direct control over text selection, overlays, and app-local annotations, and fits the selected web stack. It requires Mimosa to own more reader behavior and to carefully handle local-file access and PDF.js performance.

### Native macOS PDF view hosted by Electron

Could leverage native PDF behavior, but bridging native rendering, selection, and annotation coordinates into a web interface adds integration complexity and reduces consistency with the chosen React UI. Rejected for the first version unless PDF.js proves insufficient in a focused prototype.

### Embed annotations in the source PDF

Makes annotations portable to other PDF applications, but modifies the user’s document and complicates safe handling of original files. Rejected for the first version in favor of separate local data.

## Privacy, security, and reliability

- Local reading, annotations, and page-position persistence must work offline.
- Only an explicit translation action may transmit selected text to an external provider.
- The API key must be stored in macOS Keychain and accessed by the main process only.
- Do not log API keys, selected text, or translated output.
- Validate the configured endpoint as an external input and avoid exposing privileged Electron APIs broadly to the renderer.
- Provider errors, unavailable credentials, unsupported PDF text extraction, and untrusted document identity should produce understandable behavior without losing local notes or changing the source PDF.

## Validation and acceptance

The first usable version is ready for review when manual and automated checks demonstrate that:

1. A user can open a local PDF, read pages, navigate, zoom, and search extractable text.
2. A user can select text, underline it, close and reopen the same PDF, and see the underline in the correct place; the original file remains unchanged.
3. With a configured compatible endpoint, model, and API key, the user can translate selected English text to Chinese and Chinese text to English.
4. Without an API key, reading, notes, and position restoration still work, and translation explains how to configure credentials.
5. A failed translation request leaves the selected text intact and gives the user a useful error.
6. Reopening a previously read PDF restores its last page, while a different PDF does not inherit that page.
7. Reading, annotations, and position persistence work with network access disabled.

## Release and recovery

The repository has no application or release pipeline yet. Implementation should first be validated locally with representative PDFs, including a text PDF, a scanned/image-only PDF, a PDF with an outline, and a changed/replaced file. Do not distribute a release until macOS packaging, signing/notarization requirements, and dependency licenses have been reviewed. Local annotation data should not be automatically discarded during upgrades.

## Open decisions and decision gates

- **Before implementation:** Confirm the exact OpenAI-compatible API contract and the required endpoint/model settings. The supported translation feature depends on this choice.
- **Before implementation:** Validate PDF.js selection geometry and annotation persistence with representative PDFs; the app-local underline behavior depends on reliable mapping from selected text to rendered page coordinates.
- **Before implementation:** Choose a document identity/fingerprinting strategy that balances reliable matching with startup cost and privacy.
- **Before implementation:** Confirm whether “last position” means page only for version one or page plus scroll offset. The minimum requirement is last-page restoration.
- **Before distribution:** Decide packaging, code signing, notarization, and update strategy for macOS.
- **Unconfirmed:** Product owner/decision owner and whether users require any specific corporate LLM provider or proxy policy.
