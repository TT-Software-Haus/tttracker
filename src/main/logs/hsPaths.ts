import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

export const DEFAULT_INSTALL = 'C:\\Program Files (x86)\\Hearthstone'

export function logConfigPath(): string {
  const local = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
  return join(local, 'Blizzard', 'Hearthstone', 'log.config')
}

/** Look up the install folder from the uninstall registry key, falling back to the default. */
export async function findInstallPath(): Promise<string> {
  if (existsSync(join(DEFAULT_INSTALL, 'Hearthstone.exe'))) return DEFAULT_INSTALL
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hearthstone',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hearthstone',
  ]
  for (const key of keys) {
    const out = await new Promise<string>((res) =>
      execFile('reg', ['query', key, '/v', 'InstallLocation'], (err, stdout) => res(err ? '' : stdout)),
    )
    const m = /InstallLocation\s+REG_SZ\s+(.+)/.exec(out)
    if (m && existsSync(join(m[1].trim(), 'Hearthstone.exe'))) return m[1].trim()
  }
  return DEFAULT_INSTALL
}

export function installLooksValid(path: string) {
  return existsSync(join(path, 'Hearthstone.exe'))
}

/**
 * Modern clients write each session's logs to Logs/Hearthstone_YYYY_MM_DD_HH_MM_SS/.
 * Older clients wrote straight into Logs/. Returns the folder that is being written to now.
 */
export async function findActiveLogDir(installPath: string): Promise<string | undefined> {
  const root = join(installPath, 'Logs')
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return undefined
  }
  const sessions = entries.filter((n) => /^Hearthstone_\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/.test(n)).sort()
  if (sessions.length) return join(root, sessions[sessions.length - 1])
  return existsSync(join(root, 'Power.log')) ? root : undefined
}

// ---- log.config: Hearthstone only writes Power/Decks logs when asked to.

// Only Power.log is needed for Battlegrounds.
const REQUIRED_SECTIONS = ['Power']
// Sections earlier versions of this app enabled. Zone.log in particular is huge
// and helps push Hearthstone over its log size limit, so drop them.
const OBSOLETE_SECTIONS = ['Zone']

function sectionBody(name: string) {
  return `[${name}]\nLogLevel=1\nFilePrinting=true\nConsolePrinting=false\nScreenPrinting=false\nVerbose=true\n`
}

// By default Hearthstone stops writing ALL its logs once Power.log reaches
// ~10 MB, which in Battlegrounds happens part-way through a game. The switch is
// the client.config var "Log.FileSizeLimit.Int" (found in the game's own code),
// i.e. [Log] FileSizeLimit.Int=-1 in client.config. It is NOT a log.config setting.
// The game's code doesn't say which folder client.config is read from, so we
// write it next to log.config and into the install folder.
export function clientConfigPaths(installPath: string): string[] {
  return [join(logConfigPath(), '..', 'client.config'), join(installPath, 'client.config')]
}

function parseSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>()
  let cur: Map<string, string> | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const s = /^\[(.+)\]$/.exec(line)
    if (s) {
      cur = new Map()
      sections.set(s[1], cur)
    } else if (cur && line.includes('=')) {
      const i = line.indexOf('=')
      cur.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
    }
  }
  return sections
}

async function readSections(path: string): Promise<Map<string, Map<string, string>> | undefined> {
  try {
    return parseSections(await fs.readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

function serialize(sections: Map<string, Map<string, string>>): string {
  return [...sections].map(([name, kv]) => `[${name}]\n` + [...kv].map(([k, v]) => `${k}=${v}\n`).join('')).join('')
}

export async function checkLogConfig(installPath: string): Promise<boolean> {
  const logCfg = await readSections(logConfigPath())
  const powerOk = REQUIRED_SECTIONS.every((n) => {
    const s = logCfg?.get(n)
    return s && s.get('FilePrinting')?.toLowerCase() === 'true' && s.get('Verbose')?.toLowerCase() === 'true'
  })
  if (!powerOk) return false
  for (const p of clientConfigPaths(installPath)) {
    const cfg = await readSections(p)
    if (cfg?.get('Log')?.get('FileSizeLimit.Int') !== '-1') return false
  }
  return true
}

/** Adds/overwrites the settings we need, keeping anything else already there. */
export async function ensureLogConfig(installPath: string): Promise<void> {
  // log.config: turn on Power.log.
  const path = logConfigPath()
  const existing = await fs.readFile(path, 'utf8').catch(() => '')
  if (existing) await fs.writeFile(path + '.bak', existing)
  const sections = parseSections(existing)
  for (const name of OBSOLETE_SECTIONS) sections.delete(name)
  sections.delete('Log') // an earlier version of this app wrote the size limit here by mistake
  let out = serialize(new Map([...sections].filter(([n]) => !REQUIRED_SECTIONS.includes(n))))
  for (const name of REQUIRED_SECTIONS) out += sectionBody(name)
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, out)

  // client.config: switch the log size limit off.
  for (const p of clientConfigPaths(installPath)) {
    try {
      const cfg = (await readSections(p)) ?? new Map()
      const log = cfg.get('Log') ?? new Map<string, string>()
      log.set('FileSizeLimit.Int', '-1')
      cfg.set('Log', log)
      await fs.writeFile(p, serialize(cfg))
    } catch (err) {
      console.warn('Could not write', p, err)
    }
  }
}
