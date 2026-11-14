import { promises as fs, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BgMatch, Build, Settings } from '../shared/types'
import type { Placement } from './overlayLayout'

/** What the user and the screen said about one game, so a tracker restart mid-game keeps it. */
export interface BuildChoice {
  /** Identifies the game: log folder plus its CREATE_GAME line. */
  game: string
  buildId?: string
  answered: boolean
  /** The lobby's tribes, read off the hero-select screen. */
  tribes?: string[]
}

const DEFAULT_SETTINGS: Settings = {
  hearthstonePath: '',
  simIterations: 5000,
  overlay: { enabled: true, opacity: 0.95, scale: 1, showOdds: true, showLobby: true, showBuild: true, debugHighlights: false, locked: true },
}

/** Tiny JSON-file persistence. Writes are debounced and atomic (write temp + rename). */
class JsonFile<T> {
  value: T
  private timer?: NodeJS.Timeout

  constructor(
    private path: string,
    fallback: T,
  ) {
    try {
      this.value = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      this.value = fallback
    }
  }

  save() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 200)
  }

  async flush() {
    const tmp = this.path + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(this.value, null, 2))
    await fs.rename(tmp, this.path)
  }
}

export class Store {
  private matchesFile: JsonFile<BgMatch[]>
  private settingsFile: JsonFile<Settings>
  /** Position/size of each window, keyed by window name. */
  private boundsFile: JsonFile<Record<string, Electron.Rectangle>>
  private buildsFile: JsonFile<Build[]>
  private choiceFile: JsonFile<BuildChoice>
  /** Where each overlay sits relative to the game window; see overlayLayout.ts. */
  private placesFile: JsonFile<Record<string, Placement>>

  constructor(dir: string) {
    this.matchesFile = new JsonFile(join(dir, 'bg-matches.json'), [])
    this.settingsFile = new JsonFile(join(dir, 'settings.json'), DEFAULT_SETTINGS)
    this.boundsFile = new JsonFile(join(dir, 'windows.json'), {})
    this.buildsFile = new JsonFile(join(dir, 'builds.json'), [])
    this.choiceFile = new JsonFile(join(dir, 'build-choice.json'), { game: '', answered: false })
    this.placesFile = new JsonFile(join(dir, 'overlay-places.json'), {})
    const s = this.settingsFile.value
    this.settingsFile.value = { ...DEFAULT_SETTINGS, ...s, overlay: { ...DEFAULT_SETTINGS.overlay, ...s.overlay } }
  }

  get matches() {
    return this.matchesFile.value
  }
  get settings() {
    return this.settingsFile.value
  }

  addMatch(m: BgMatch) {
    this.matches.push(m)
    this.matchesFile.save()
  }

  deleteMatch(id: string) {
    this.matchesFile.value = this.matches.filter((m) => m.id !== id)
    this.matchesFile.save()
  }

  get builds() {
    return this.buildsFile.value
  }

  /** Insert or replace by id. */
  saveBuild(b: Build) {
    const i = this.builds.findIndex((x) => x.id === b.id)
    if (i >= 0) this.builds[i] = b
    else this.builds.push(b)
    this.buildsFile.save()
  }

  get buildChoice() {
    return this.choiceFile.value
  }

  /** Only the latest game is kept: an older one can never be resumed. */
  setBuildChoice(c: BuildChoice) {
    this.choiceFile.value = c
    this.choiceFile.save()
  }

  deleteBuild(id: string) {
    this.buildsFile.value = this.builds.filter((b) => b.id !== id)
    this.buildsFile.save()
  }

  updateSettings(patch: Partial<Settings>) {
    const cur = this.settings
    this.settingsFile.value = { ...cur, ...patch, overlay: { ...cur.overlay, ...(patch.overlay ?? {}) } }
    this.settingsFile.save()
  }

  getBounds(name: string) {
    return this.boundsFile.value[name]
  }

  getPlacement(name: string): Placement | undefined {
    return this.placesFile.value[name]
  }

  setPlacement(name: string, p: Placement) {
    this.placesFile.value[name] = p
    this.placesFile.save()
  }

  setBounds(name: string, b: Electron.Rectangle) {
    this.boundsFile.value[name] = b
    this.boundsFile.save()
  }

  async flushAll() {
    await Promise.all([this.matchesFile, this.settingsFile, this.boundsFile, this.buildsFile, this.choiceFile, this.placesFile].map((f) => f.flush()))
  }
}
