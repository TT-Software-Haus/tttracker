/**
 * Performance profiling, opt-in: launch with `--profile` (in dev,
 * `npm run dev -- -- --profile`). Without it, everything here is a no-op.
 *
 * What it watches matters more here than in most apps: the overlays' forwarded
 * click-through installs a system-wide mouse hook on the main thread, so while
 * that thread is blocked the user's cursor freezes (see CLAUDE.md, "Never block
 * the main process").
 */
export const profiling = process.argv.includes('--profile')

/** Log a named moment, with the time since the process started. */
export function mark(step: string) {
  if (profiling) console.log(`[profile] ${performance.now().toFixed(0)}ms ${step}`)
}

/**
 * Notice when the main thread was blocked: a timer that fires late was held up
 * by synchronous work for the difference. Over 25ms, not a frame's 16: Windows
 * timers tick at ~15.6ms, so a 20ms timer can fire ~16ms late with nothing
 * blocking.
 */
export function watchStalls(onStall: (ms: number) => void, thresholdMs = 25, tickMs = 20, enabled = profiling) {
  if (!enabled) return () => {}
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const late = now - last - tickMs
    last = now
    if (late > thresholdMs) onStall(Math.round(late))
  }, tickMs)
  timer.unref()
  return () => clearInterval(timer)
}
