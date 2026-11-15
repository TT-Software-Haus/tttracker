/// <reference types="electron-vite/node" />
import type { Worker } from 'node:worker_threads'
import createSimWorker from './simWorker?nodeWorker'
import type { BoardInput, simulateMany } from './engine'
import type { SimOdds } from '../../../shared/types'
import { newestOnly } from './newestOnly'

export interface SimJob {
  a: BoardInput
  b: BoardInput
  opts: Parameters<typeof simulateMany>[3]
}
/** `lane: 'live'`: only the newest job of the lane matters (see newestOnly). */
export type Simulator = (job: SimJob, opts?: { lane?: 'live' }) => Promise<SimOdds>

/**
 * Combat sims on a worker thread (simWorker.ts), one at a time in order. Kept
 * out of the tests' way: only main's index.ts imports this, since the
 * `?nodeWorker` import is an electron-vite build feature.
 */
export function workerSimulator(cacheDir: string): Simulator {
  let worker: Worker | undefined
  let next = 0
  const pending = new Map<number, { resolve: (o: SimOdds) => void; reject: (e: Error) => void }>()
  const start = () => {
    const w = createSimWorker({ workerData: { cacheDir } })
    w.unref() // never keeps the app alive
    w.on('message', ({ id, odds, error }: { id: number; odds?: SimOdds; error?: string }) => {
      const p = pending.get(id)
      pending.delete(id)
      if (error || !odds) p?.reject(new Error(error ?? 'no result'))
      else p?.resolve(odds)
    })
    // A crashed worker fails what it had; the next job starts a fresh one.
    w.on('error', (err: Error) => {
      for (const p of pending.values()) p.reject(err)
      pending.clear()
      worker = undefined
    })
    return w
  }
  // Spawned now, not on the first sim: starting a worker blocks the thread for
  // ~50ms, and by the first combat the overlays' mouse hook is up, so that froze
  // the cursor (seen with --profile). Main calls this before any window exists.
  worker = start()
  const post = (job: SimJob) =>
    new Promise<SimOdds>((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      worker ??= start()
      worker.postMessage({ id, ...job })
    })
  const live = newestOnly(post)
  return (job, opts) => (opts?.lane === 'live' ? live(job) : post(job))
}
