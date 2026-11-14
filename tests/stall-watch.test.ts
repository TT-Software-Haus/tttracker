import { describe, expect, it } from 'vitest'
import { watchStalls } from '../src/main/stallWatch'

describe('the main-thread stall watchdog', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const busy = (ms: number) => {
    const end = performance.now() + ms
    while (performance.now() < end);
  }

  it('reports a block longer than the threshold, about as long as it was', async () => {
    const stalls: number[] = []
    const stop = watchStalls((ms) => stalls.push(ms))
    await wait(60)
    busy(150)
    await wait(60)
    stop()
    expect(stalls).toHaveLength(1)
    expect(stalls[0]).toBeGreaterThanOrEqual(110)
    expect(stalls[0]).toBeLessThan(250)
  })

  it('stays quiet when nothing blocks', async () => {
    const stalls: number[] = []
    const stop = watchStalls((ms) => stalls.push(ms))
    await wait(200)
    stop()
    expect(stalls).toEqual([])
  })
})
