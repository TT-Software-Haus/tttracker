// Kept apart from remote.ts, which pulls in the worker build, so it can be tested.

export class Superseded extends Error {
  name = 'Superseded'
  constructor() {
    super('superseded by a newer sim')
  }
}

/**
 * Wrap `run` so only the newest call matters: while one runs, a newer one waits in its place and
 * the one it replaces is rejected with `Superseded`. Live odds re-sim after every attack; this
 * keeps a fight's 20-30 attacks from queueing 20-30 sims.
 */
export function newestOnly<J, R>(run: (job: J) => Promise<R>): (job: J) => Promise<R> {
  let busy = false
  let waiting: { job: J; resolve: (r: R) => void; reject: (e: Error) => void } | undefined
  const start = (job: J): Promise<R> => {
    busy = true
    return run(job).finally(() => {
      busy = false
      const w = waiting
      waiting = undefined
      if (w) start(w.job).then(w.resolve, w.reject)
    })
  }
  return (job) => {
    if (!busy) return start(job)
    waiting?.reject(new Superseded())
    return new Promise<R>((resolve, reject) => {
      waiting = { job, resolve, reject }
    })
  }
}
