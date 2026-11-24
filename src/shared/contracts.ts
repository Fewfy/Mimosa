export type Rect = { x: number; y: number; width: number; height: number }
export type ConversationMessage = { role: 'user' | 'assistant'; content: string; at: number }
export type PassageConversation = { messages: ConversationMessage[]; updatedAt: number }
export type UnderlineAnnotation = { id: string; page: number; text: string; rects: Rect[]; comment?: string; conversation?: PassageConversation }
export type AskPassageInput = {
  passage: string
  page: number
  context: string
  question: string
  history: Array<Pick<ConversationMessage, 'role' | 'content'>>
}
export type DocumentRecord = { page: number; annotations: UnderlineAnnotation[]; name?: string; path?: string; lastOpenedAt?: number }
export type OpenedDocument = { id: string; name: string; bytes: ArrayBuffer; page: number; annotations: UnderlineAnnotation[] }
export type RecentDocument = { id: string; name: string; lastOpenedAt: number }
export type OpenRecentResult = { status: 'opened'; document: OpenedDocument } | { status: 'missing' | 'changed'; name: string }
export type TranslationSettings = { endpoint: string; model: string }
export type TranslationSettingsStatus = TranslationSettings & { configured: boolean }

export interface MimosaApi {
  openPdf(): Promise<OpenedDocument | null>
  listRecent(): Promise<RecentDocument[]>
  openRecent(id: string): Promise<OpenRecentResult>
  locateRecent(id: string): Promise<OpenRecentResult | null>
  savePage(id: string, page: number): Promise<void>
  saveAnnotation(id: string, annotation: UnderlineAnnotation): Promise<void>
  deleteAnnotation(id: string, annotationId: string): Promise<void>
  getTranslationSettings(): Promise<TranslationSettingsStatus | null>
  setTranslationSettings(settings: TranslationSettings, key: string): Promise<void>
  clearTranslationSettings(): Promise<void>
  translate(text: string, target: 'en' | 'zh'): Promise<string>
  askPassage(input: AskPassageInput): Promise<string>
}

declare global {
  interface Window { mimosa: MimosaApi }
}
