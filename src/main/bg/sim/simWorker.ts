// Runs combat sims off the main thread. The main thread carries a system-wide
// mouse hook (see CLAUDE.md), so a sim there froze the user's cursor for as
// long as it ran: 17-84ms a combat in a real game, with a 400ms budget.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { CACHE_FILE, CardDb } from '../../cards/cardDb'
import { simulateMany } from './engine'
import type { SimJob } from './remote'

let cards: CardDb | undefined
parentPort!.on('message', ({ id, a, b, opts }: SimJob & { id: number }) => {
  try {
    // Loaded on the first job, from the cache main has written by then (it
    // loads the cards before it reads the log). No download here.
    if (!cards) {
      cards = new CardDb()
      cards.load(JSON.parse(readFileSync(join(workerData.cacheDir, CACHE_FILE), 'utf8')))
    }
    parentPort!.postMessage({ id, odds: simulateMany(cards, a, b, opts) })
  } catch (err) {
    parentPort!.postMessage({ id, error: String(err) })
  }
})
