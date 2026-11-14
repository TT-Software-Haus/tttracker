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
    /** `more`: this read hasn't reached the end of the file yet; the rest follows at once. */
    private onLines: (lines: string[], more: boolean) => void,
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
        // A chunk at a time: decoding and splitting the whole of a game in
        // progress (tens of MB) in one go blocked the main thread for ~30ms,
        // and its mouse hook froze the user's cursor with it (CLAUDE.md).
        while (this.offset < stat.size) {
          const len = Math.min(stat.size - this.offset, READ_CHUNK)
          const buf = Buffer.alloc(len)
          const { bytesRead } = await fh.read(buf, 0, len, this.offset)
          if (!bytesRead) break
          this.offset += bytesRead
          const text = this.partial + buf.subarray(0, bytesRead).toString('utf8')
          const lines = text.split(/\r?\n/)
          this.partial = lines.pop() ?? ''
          const more = this.offset < stat.size
          // The last call of a read always goes out, lines or not: the caller
          // waits for more=false.
          if (lines.length || !more) this.onLines(lines, more)
        }
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
  // Searched from the end a chunk at a time: the current game is near the end
  // of a file that reaches 70MB, and reading and searching all of it blocked
  // the main thread for ~30ms.
  const needle = Buffer.from('GameState.DebugPrintPower() - CREATE_GAME')
  let fh: fs.FileHandle | undefined
  try {
    fh = await fs.open(path, 'r')
    const size = (await fh.stat()).size
    let end = size
    while (end > 0) {
      const start = Math.max(0, end - READ_CHUNK)
      // Overlaps the chunk after it by a needle's length, so a match split
      // across two chunks is still found.
      const buf = Buffer.alloc(Math.min(end + needle.length, size) - start)
      await fh.read(buf, 0, buf.length, start)
      const idx = buf.lastIndexOf(needle)
      if (idx >= 0) {
        // Back to the start of that line; log lines are far shorter than this.
        const at = start + idx
        const back = Math.min(at, 4096)
        const before = Buffer.alloc(back)
        await fh.read(before, 0, back, at - back)
        const nl = before.lastIndexOf(10)
        return nl < 0 ? at - back : at - back + nl + 1
      }
      end = start
    }
    return size
  } catch {
    return 0
  } finally {
    await fh?.close()
  }
}

/** The most read from Power.log in one go, so no single step holds the main thread. */
const READ_CHUNK = 1 << 20
