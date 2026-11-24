import { contextBridge, ipcRenderer } from 'electron'
import type { MimosaApi, TranslationSettings, TranslationSettingsStatus, UnderlineAnnotation } from '../shared/contracts.js'

const api: MimosaApi = {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  listRecent: () => ipcRenderer.invoke('recent:list'),
  openRecent: (id: string) => ipcRenderer.invoke('recent:open', id),
  locateRecent: (id: string) => ipcRenderer.invoke('recent:locate', id),
  savePage: (id, page) => ipcRenderer.invoke('document:save-page', id, page),
  saveAnnotation: (id, annotation) => ipcRenderer.invoke('document:save-annotation', id, annotation),
  deleteAnnotation: (id, annotationId) => ipcRenderer.invoke('document:delete-annotation', id, annotationId),
  getTranslationSettings: () => ipcRenderer.invoke('translation:get-settings') as Promise<TranslationSettingsStatus | null>,
  setTranslationSettings: (settings: TranslationSettings, key: string) => ipcRenderer.invoke('translation:set-settings', settings, key),
  clearTranslationSettings: () => ipcRenderer.invoke('translation:clear-settings'),
  translate: (text: string, target: 'en' | 'zh') => ipcRenderer.invoke('translation:translate', text, target)
}

contextBridge.exposeInMainWorld('mimosa', api)
