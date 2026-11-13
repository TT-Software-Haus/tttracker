import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { Build, BuildTarget } from '../shared/types'

/**
 * Builds as a short shareable string.
 *
 * Three things keep it short enough to paste into a chat message. Cards travel
 * as dbfIds rather than card ids ("BG28_633" is 8 bytes, 110664 is 6 and
 * compresses far better). The payload is a positional array, so none of the
 * field names are in it. And it's deflated before base64 — all stdlib, no
 * dependency. A three-stage build lands around 150 characters.
 *
 * The lookups are injected so this can be tested without electron, and so the
 * card database stays the one place that knows about dbfIds.
 */
const PREFIX = 'HTB1'

type Payload = [name: string, tribe: string, stages: [number, ...number[]][], addons: number[], source?: [string, string]]

export function encodeBuild(build: Build, dbfOf: (cardId: string) => number | undefined): string {
  const stages = build.targets.map((t) => [t.byTurn, ...t.cardIds.map(dbfOf).filter((d): d is number => !!d)] as [number, ...number[]])
  const payload: Payload = [build.name, build.tribe, stages, (build.addons ?? []).map(dbfOf).filter((d): d is number => !!d)]
  if (build.source) payload.push([build.source.name, build.source.url])
  return PREFIX + deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 }).toString('base64url')
}

export interface Decoded {
  /** Everything but the id — the importer assigns a fresh one. */
  build: Omit<Build, 'id'>
  /** Cards the local database couldn't resolve, so the board is incomplete. */
  missing: number
}

export function decodeBuild(code: string, idOf: (dbfId: number) => string | undefined): Decoded {
  const trimmed = code.trim()
  if (!trimmed.startsWith(PREFIX)) throw new Error("That doesn't look like a build code")
  let payload: Payload
  try {
    payload = JSON.parse(inflateRawSync(Buffer.from(trimmed.slice(PREFIX.length), 'base64url')).toString('utf8'))
  } catch {
    throw new Error('That build code is damaged or incomplete')
  }
  const [name, tribe, stages, addons, source] = payload
  if (typeof name !== 'string' || !Array.isArray(stages)) throw new Error('That build code is damaged or incomplete')

  let missing = 0
  // A dbfId this card database doesn't know is dropped, but counted — the
  // importer says so rather than quietly handing over a short board.
  const resolve = (dbfs: number[]) =>
    dbfs
      .map((d) => {
        const id = idOf(d)
        if (!id) missing++
        return id
      })
      .filter((id): id is string => !!id)

  const targets: BuildTarget[] = stages.map(([byTurn, ...dbfs]) => ({ byTurn, cardIds: resolve(dbfs) }))
  const build: Omit<Build, 'id'> = { name, tribe: tribe ?? '', targets, addons: resolve(addons ?? []) }
  if (source) build.source = { name: source[0], url: source[1] }
  return { build, missing }
}
