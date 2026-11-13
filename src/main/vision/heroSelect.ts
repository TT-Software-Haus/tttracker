import { desktopCapturer } from 'electron'
import { PSM, createWorker, type Worker } from 'tesseract.js'
import { parseTribeBanner } from './tribeNames'
import { findBannerRect } from './bannerRect'

let worker: Worker | undefined

/**
 * The language data (~5 MB) downloads once and is cached, like the card
 * database. The cache path must be set explicitly: tesseract.js defaults to the
 * working directory, which for a packaged app is wherever Windows happened to
 * launch it from — possibly read-only, and never the same place twice.
 */
async function getWorker(cacheDir: string) {
  if (!worker) {
    worker = await createWorker('eng', undefined, { cachePath: cacheDir })
    // These two are what make the read repeatable. On the default settings
    // tesseract runs layout analysis over the crop, and on a real frame a
    // *one pixel* difference in the box was enough to lose a tribe. SPARSE_TEXT
    // makes no layout assumption, and the whitelist stops the banner's
    // decorative flourishes being read as letters. With both, every crop from
    // the detected box out to a 1920x245 band reads all five tribes.
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz, ',
    })
  }
  return worker
}

export async function stopVision() {
  const w = worker
  worker = undefined
  await w?.terminate()
}

/** The Hearthstone window, or undefined if it isn't running or is minimised. */
async function captureGameWindow() {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 2560, height: 1440 } })
  const hs = sources.find((s) => s.name === 'Hearthstone')
  return hs && !hs.thumbnail.isEmpty() ? hs.thumbnail : undefined
}

/**
 * The lobby's minion types, read off the hero-select screen. Returns [] if the
 * game can't be captured or the banner isn't up — callers must treat that as
 * "don't know" rather than "no tribes", and try again.
 */
export async function readLobbyTribes(cacheDir: string): Promise<string[]> {
  const shot = await captureGameWindow()
  if (!shot) return []
  const { width, height } = shot.getSize()
  const rect = findBannerRect(shot.toBitmap(), width, height)
  if (!rect) return []
  const crop = shot.crop(rect)
  if (crop.isEmpty()) return []
  const { data } = await (await getWorker(cacheDir)).recognize(crop.toPNG())
  return parseTribeBanner(data.text)
}
