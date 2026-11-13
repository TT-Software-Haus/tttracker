/**
 * The capture window's whole job: stream the Hearthstone window and hand main a
 * frame when asked. Main calls `window.capture` through executeJavaScript.
 *
 * This replaces desktopCapturer.getSources(), which renders a thumbnail of every
 * open window to return one (24 windows here: ~1.3s and 57MB per call at 720p).
 * A stream of one window costs one frame per read, 13-17ms.
 *
 * Frames come from a <video> element rather than ImageCapture.grabFrame():
 * Chromium only sends a frame when the window changes, and grabFrame() rejected
 * whenever nothing had, where the video element always holds the latest frame.
 */
let stream: MediaStream | undefined
let video: HTMLVideoElement | undefined
let openHeight = 0

async function open(height: number) {
  close()
  // Main answers this request with the Hearthstone window. 5fps: the first
  // frame arrives ~0.9s after opening (2.4s at 2fps), and an open stream
  // measured under 1% of a core at any rate tried, up to 15.
  stream = await navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: { height, width: Math.round((height * 16) / 9), frameRate: 5 },
  })
  openHeight = height
  const v = document.createElement('video')
  v.muted = true
  v.srcObject = stream
  await v.play()
  // The first frame can lag play() slightly; don't wait forever for it.
  if (!v.videoWidth) await new Promise<void>((r) => (v.addEventListener('loadeddata', () => r(), { once: true }), setTimeout(r, 2000)))
  video = v
}

function close() {
  stream?.getTracks().forEach((t) => t.stop())
  stream = undefined
  video = undefined
  openHeight = 0
}

/** The latest frame at `height` (width follows the window), as BGRA like NativeImage.toBitmap(). */
async function frame(height: number) {
  if (!stream?.active || openHeight !== height) await open(height)
  const v = video
  if (!v?.videoWidth || !v.videoHeight) return undefined
  const ctx = new OffscreenCanvas(v.videoWidth, v.videoHeight).getContext('2d', { willReadFrequently: true })
  if (!ctx) return undefined
  ctx.drawImage(v, 0, 0)
  const px = ctx.getImageData(0, 0, v.videoWidth, v.videoHeight).data
  // Canvas is RGBA; the detectors were written against NativeImage's BGRA.
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]
    px[i] = px[i + 2]
    px[i + 2] = r
  }
  return { width: v.videoWidth, height: v.videoHeight, bgra: px }
}

declare global {
  interface Window {
    capture: { frame: typeof frame; close: typeof close }
  }
}

export function startCapture() {
  window.capture = { frame, close }
}
