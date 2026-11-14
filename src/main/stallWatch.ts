/**
 * Notices when the main thread was blocked. That matters more here than in most
 * apps: the overlays' forwarded click-through installs a system-wide mouse hook
 * on this thread, so while it's blocked the user's cursor freezes (see CLAUDE.md,
 * "Never block the main process"). A timer that fires late was held up by
 * synchronous work for the difference.
 */
export function watchStalls(onStall: (ms: number) => void, thresholdMs = 50, tickMs = 20) {
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
