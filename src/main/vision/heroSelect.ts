import { desktopCapturer } from 'electron'
import { createWorker, type Worker } from 'tesseract.js'
import { parseTribeBanner } from './tribeNames'

/**
 * Where the minion-type banner sits during hero select, as a fraction of the
 * Hearthstone window — measured off a 16:9 capture, with padding for the
 * two-line wrap ("Demons, Dragons, Elementals, / Mechs, Pirates").
 *
 * ponytail: fixed fractions rather than finding the banner. Hearthstone lays
 * its UI out proportionally, so this holds across resolutions at the same
 * aspect; if a UI scale setting shifts it, the upgrade is locating the
 * "Choose a Hero" plate by template match and working relative to that.
 */
export const DEFAULT_BANNER_RECT = { x: 0.4, y: 0.133, w: 0.21, h: 0.062 }

let worker: Worker | undefined

/**
 * The language data (~5 MB) downloads once and is cached, like the card
 * database. The cache path must be set explicitly: tesseract.js defaults to the
 * working directory, which for a packaged app is wherever Windows happened to
 * launch it from — possibly read-only, and never the same place twice.
 */
async function getWorker(cacheDir: string) {
  worker ??= await createWorker('eng', undefined, { cachePath: cacheDir })
  return worker
}

export async function stopVision() {
  const w = worker
  worker = undefined
  await w?.terminate()
}

/** The Hearthstone window, or undefined if it isn't running or is minimised. */
async function captureGameWindow() {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 } })
  const hs = sources.find((s) => s.name === 'Hearthstone')
  return hs && !hs.thumbnail.isEmpty() ? hs.thumbnail : undefined
}

/**
 * The lobby's minion types, read off the hero-select screen. Returns [] if the
 * game can't be captured or the banner isn't on screen — callers must treat
 * that as "don't know" rather than "no tribes".
 */
export async function readLobbyTribes(cacheDir: string, rect = DEFAULT_BANNER_RECT): Promise<string[]> {
  const shot = await captureGameWindow()
  if (!shot) return []
  const { width, height } = shot.getSize()
  const crop = shot.crop({
    x: Math.round(rect.x * width),
    y: Math.round(rect.y * height),
    width: Math.round(rect.w * width),
    height: Math.round(rect.h * height),
  })
  if (crop.isEmpty()) return []
  const { data } = await (await getWorker(cacheDir)).recognize(crop.toPNG())
  return parseTribeBanner(data.text)
}
