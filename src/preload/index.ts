import { contextBridge, ipcRenderer } from 'electron'
import type { BgMatch, BgSnapshot, Build, CardInfo, Comp, Settings, SetupStatus } from '../shared/types'

function subscribe<T>(channel: string, fn: (payload: T) => void) {
  const handler = (_e: unknown, payload: T) => fn(payload)
  ipcRenderer.on(channel, handler)
  return () => void ipcRenderer.removeListener(channel, handler)
}

const api = {
  snapshot: (): Promise<BgSnapshot> => ipcRenderer.invoke('tracker:snapshot'),
  onSnapshot: (fn: (s: BgSnapshot) => void) => subscribe('tracker:snapshot', fn),
  onDataChanged: (fn: () => void) => subscribe('data:changed', fn),
  onSettingsChanged: (fn: (s: Settings) => void) => subscribe('settings:changed', fn),

  setupStatus: (): Promise<SetupStatus> => ipcRenderer.invoke('setup:status'),
  fixLogConfig: (): Promise<void> => ipcRenderer.invoke('setup:fixLogConfig'),
  browseInstall: (): Promise<string | undefined> => ipcRenderer.invoke('setup:browse'),

  matches: (): Promise<BgMatch[]> => ipcRenderer.invoke('matches:list'),
  deleteMatch: (id: string): Promise<void> => ipcRenderer.invoke('matches:delete', id),
  pool: (): Promise<CardInfo[]> => ipcRenderer.invoke('cards:pool'),

  builds: (): Promise<Build[]> => ipcRenderer.invoke('builds:list'),
  saveBuild: (b: Build): Promise<void> => ipcRenderer.invoke('builds:save', b),
  deleteBuild: (id: string): Promise<void> => ipcRenderer.invoke('builds:delete', id),
  selectBuild: (id: string | null): Promise<void> => ipcRenderer.invoke('builds:select', id),
  comps: (): Promise<Comp[]> => ipcRenderer.invoke('comps:list'),

  settings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:update', patch),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
