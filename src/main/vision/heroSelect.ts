import { desktopCapturer } from 'electron'
import { PSM, createWorker, type Worker } from 'tesseract.js'
import { parseTribeBanner } from './tribeNames'
import { findBannerRect, type Rect } from './bannerRect'
import { findShopSlots } from './shopSlots'
import { captureFrame } from './stream'

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

/**
 * Read the crop twice, under two different page-segmentation modes, and take
 * everything either pass found.
 *
 * Neither mode is reliable alone, measured on real frames: SPARSE_TEXT ignores
 * layout and is steady against small crop changes, but dropped the last word
 * on a 1080p banner ("Dragons, Murlocs, Pir"). AUTO read that frame perfectly
 * but is the mode where a one-pixel change to the box once cost a tribe.
 *
 * Merging is safe because the parser only accepts words close to a real tribe
 * name — it ignores the rest of the screen's wording — so a pass that reads
 * badly contributes nothing rather than contributing nonsense.
 */
async function readTribes(cacheDir: string, png: Buffer): Promise<string[]> {
  const w = await getWorker(cacheDir)
  const found = new Set<string>()
  for (const psm of [PSM.SPARSE_TEXT, PSM.AUTO]) {
    await w.setParameters({
      tessedit_pageseg_mode: psm,
      // Stops the banner's flourishes being read as letters.
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz, ',
    })
    const { data } = await w.recognize(png)
    for (const t of parseTribeBanner(data.text)) found.add(t)
  }
  return [...found].sort()
}

export async function stopVision() {
  const w = worker
  worker = undefined
  await w?.terminate()
}

/**
 * The Hearthstone window, or undefined if it isn't running or is minimised.
 *
 * getSources() renders a thumbnail of *every* open window at this size and
 * there's no asking for just one. Measured with 24 windows open: 227MB per
 * call at 2560x1440, 57MB at 1280x720. So callers ask for the smallest size
 * that does the job.
 */
async function captureGameWindow(size: { width: number; height: number }) {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size })
  const hs = sources.find((s) => s.name === 'Hearthstone')
  return hs && !hs.thumbnail.isEmpty() ? hs.thumbnail : undefined
}

/**
 * The lobby's minion types, read off the hero-select screen. Returns [] if the
 * game can't be captured or the banner isn't up — callers must treat that as
 * "don't know" rather than "no tribes", and try again.
 */
export async function readLobbyTribes(cacheDir: string): Promise<string[]> {
  // Full size: tesseract needs crisp text, and this only runs during hero select.
  const shot = await captureGameWindow({ width: 2560, height: 1440 })
  if (!shot) return []
  const { width, height } = shot.getSize()
  const rect = findBannerRect(shot.toBitmap(), width, height)
  if (!rect) return []
  const crop = shot.crop(rect)
  if (crop.isEmpty()) return []
  return readTribes(cacheDir, crop.toPNG())
}

/** The Hearthstone window's position on the desktop, plus where its tavern cards are. */
export interface ShopGeometry {
  /** Screen-space rect of each tavern slot, left to right. */
  slots: Rect[]
  /** The captured frame's size, for scaling to the real window. */
  frame: { width: number; height: number }
}

/**
 * Locate the tavern's cards on screen.
 *
 * Returns frame-space rects; the caller scales them to the window, because the
 * frame is captured at a fixed height and is rarely 1:1 with the real window.
 * 720 high: the shields are found just as well as at 4K (real frames scaled
 * down agreed to 3px), at a quarter of the pixels.
 */
export async function readShopSlots(): Promise<ShopGeometry | undefined> {
  const frame = await captureFrame(720)
  if (!frame) return undefined
  const slots = findShopSlots(frame.bgra, frame.width, frame.height)
  return slots.length ? { slots, frame: { width: frame.width, height: frame.height } } : undefined
}
