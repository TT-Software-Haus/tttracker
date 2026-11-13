import { promises as fs } from 'node:fs'

/**
 * Polls a growing text file and hands back complete new lines.
 * Polling (rather than fs.watch) is what every HS tracker does: Hearthstone
 * keeps the file open and Windows change notifications are unreliable for it.
 */
export class LogTail {
  private offset = 0
  private partial = ''
  private timer?: NodeJS.Timeout
  private busy = false

  constructor(
    readonly path: string,
    private onLines: (lines: string[]) => void,
    private intervalMs = 150,
  ) {}

  /** Start tailing. `fromOffset` lets the caller skip already-processed history. */
  start(fromOffset = 0) {
    this.offset = fromOffset
    this.partial = ''
    this.timer = setInterval(() => void this.poll(), this.intervalMs)
    void this.poll()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async poll() {
    if (this.busy) return
    this.busy = true
    try {
      const stat = await fs.stat(this.path).catch(() => undefined)
      if (!stat) return
      if (stat.size < this.offset) {
        // File was truncated / recreated.
        this.offset = 0
        this.partial = ''
      }
      if (stat.size === this.offset) return
      const fh = await fs.open(this.path, 'r')
      try {
        const len = stat.size - this.offset
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, this.offset)
        this.offset += bytesRead
        const text = this.partial + buf.subarray(0, bytesRead).toString('utf8')
        const lines = text.split(/\r?\n/)
        this.partial = lines.pop() ?? ''
        if (lines.length) this.onLines(lines)
      } finally {
        await fh.close()
      }
    } catch (err) {
      console.warn('LogTail poll failed', this.path, err)
    } finally {
      this.busy = false
    }
  }
}

/**
 * Byte offset of the last CREATE_GAME in Power.log, so starting the tracker
 * mid-game replays only the current game instead of the whole session.
 */
export async function lastGameOffset(path: string): Promise<number> {
  try {
    const buf = await fs.readFile(path)
    const idx = buf.lastIndexOf('GameState.DebugPrintPower() - CREATE_GAME')
    if (idx < 0) return buf.length
    const lineStart = buf.lastIndexOf('\n', idx)
    return lineStart < 0 ? 0 : lineStart + 1
  } catch {
    return 0
  }
}
