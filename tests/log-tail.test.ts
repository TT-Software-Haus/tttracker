import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LogTail, lastGameOffset } from '../src/main/logs/logTail'

/**
 * Power.log reaches 70MB, and reading it in one go blocked the main thread,
 * which carries a system-wide mouse hook (CLAUDE.md). Both reads now go a
 * megabyte at a time, so these check the chunk edges.
 */
describe('reading Power.log a chunk at a time', () => {
  const MB = 1 << 20
  const create = 'D 20:00:00.0 GameState.DebugPrintPower() - CREATE_GAME'
  const filler = (bytes: number) => ('D 20:00:00.0 GameState.DebugPrintPower() -     TAG_CHANGE x\n'.repeat(Math.ceil(bytes / 58))).slice(0, bytes)
  let dir: string
  beforeEach(async () => (dir = await fs.mkdtemp(join(tmpdir(), 'ht-tail-'))))
  afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

  const write = async (text: string) => {
    const p = join(dir, 'Power.log')
    await fs.writeFile(p, text)
    return p
  }

  it('finds the last game, with older games and megabytes after it', async () => {
    const before = filler(3 * MB) + '\n' + create + '\n' + filler(MB) + '\n'
    const text = before + create + '\n' + filler(2.5 * MB)
    expect(await lastGameOffset(await write(text))).toBe(before.length)
  })

  it('finds a game line that straddles a chunk boundary', async () => {
    // From the end, the first chunk starts at size - 1MB. With T bytes after
    // the match, that's inside it whenever 1MB - match length < T < 1MB.
    for (const cut of [5, 20, create.length - 3]) {
      const head = filler(2 * MB) + '\n'
      const text = head + create + filler(MB - cut)
      const chunkStart = text.length - MB
      expect(chunkStart).toBeGreaterThan(head.length)
      expect(chunkStart).toBeLessThan(head.length + create.length)
      const offset = await lastGameOffset(await write(text))
      expect(text.slice(offset, offset + create.length)).toBe(create)
    }
  })

  it('returns the end of the file when there is no game, and 0 at the very start', async () => {
    const none = filler(2 * MB)
    expect(await lastGameOffset(await write(none))).toBe(none.length)
    expect(await lastGameOffset(await write(create + '\n' + filler(10)))).toBe(0)
  })

  it('delivers every line once, in order, across chunks', async () => {
    const lines = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(i % 50)}`)
    const p = await write(lines.join('\n') + '\n')
    const got: string[] = []
    const more: boolean[] = []
    const tail = new LogTail(p, (l, m) => (got.push(...l), more.push(m)), 10_000)
    tail.start(0)
    while (got.length < lines.length) await new Promise((r) => setTimeout(r, 20))
    tail.stop()
    expect(got).toEqual(lines)
    // One read, several chunks: "more" on every call but the last.
    expect(more.length).toBeGreaterThan(1)
    expect(more.slice(0, -1).every(Boolean)).toBe(true)
    expect(more.at(-1)).toBe(false)
  })

  it('keeps a UTF-8 character whole across a chunk edge and across polls', async () => {
    // "é" is two bytes; put its first byte last in the first megabyte.
    const name = 'D 20:00:00.0 PlayerName=Zoé'
    const head = filler(MB - name.length - 1) + '\n'
    const first = head + name + '\n'
    expect(Buffer.byteLength(head + 'D 20:00:00.0 PlayerName=Zo')).toBe(MB - 1)
    const p = await write(first)
    const got: string[] = []
    const tail = new LogTail(p, (l) => got.push(...l), 20)
    tail.start(0)
    while (!got.includes(name)) await new Promise((r) => setTimeout(r, 20))
    // A write that stops mid-character, finished on a later poll.
    const tail2 = Buffer.from('Renée\n')
    await fs.appendFile(p, tail2.subarray(0, 4)) // "Ren" + first byte of "é"
    await new Promise((r) => setTimeout(r, 100))
    await fs.appendFile(p, tail2.subarray(4))
    while (!got.includes('Renée')) await new Promise((r) => setTimeout(r, 20))
    tail.stop()
    expect(got.filter((l) => l.includes('�'))).toEqual([])
  })
})
