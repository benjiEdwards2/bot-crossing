/**
 * Share Crossing — file-share activity scanner.
 *
 * Walks a set of allowlisted network-share roots, diffs each pass against the previous
 * snapshot, and attributes the changed bytes to whoever last saved the Office file (read
 * straight out of the docx/xlsx/pptx zip's `docProps/core.xml`, no Office install needed).
 * The result accumulates in a per-person, per-file ledger that survives across runs.
 *
 * Nothing in here ever writes inside a scanned root — the only file this module writes is
 * its own state file, atomically, by the same tmp-then-rename pattern `server/api.mjs` uses
 * for `colony.json`.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

// ── config ──────────────────────────────────────────────────────────────────

export function defaultConfig() {
  return {
    roots: [],
    exclude: ['~$*', '*.tmp', '**/Archive/**'],
    maxDepth: 6,
    maxFiles: 20000,
  }
}

export async function loadConfig(configPath) {
  const raw = JSON.parse(await fsp.readFile(configPath, 'utf8'))
  if (!Array.isArray(raw.roots) || raw.roots.length === 0) {
    throw new Error('config roots must be a non-empty array')
  }
  return { ...defaultConfig(), ...raw }
}

// ── exclude matcher ─────────────────────────────────────────────────────────

/**
 * Tiny glob-ish matcher, just enough for `~$*`, `*.tmp`, `*` `*`/Archive/`*` `*` (a doubled
 * star either side of a segment, written apart here only so it doesn't close this comment).
 * A single `*` matches any run of characters within one path segment (not `/`); a doubled
 * star matches any run of characters including `/`. Everything else is a literal.
 */
function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      // A leading `**/` is an optional "any directories above this" prefix — it must also
      // match when the segment it names is already at the root, with nothing before it.
      out += '(?:.*/)?'
      i += 2
    } else if (glob[i] === '/' && glob[i + 1] === '*' && glob[i + 2] === '*' && i + 3 === glob.length) {
      // A trailing `/**` likewise matches nothing at all, not just "at least one more segment".
      out += '(?:/.*)?'
      i += 2
    } else if (glob[i] === '*' && glob[i + 1] === '*') {
      out += '.*'
      i++
    } else if (glob[i] === '*') {
      out += '[^/]*'
    } else {
      out += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/** Matches a file if any exclude pattern matches its base name or its root-relative path. */
function isExcluded(name, relPath, patterns) {
  for (const pattern of patterns) {
    const re = globToRegExp(pattern)
    if (re.test(name) || re.test(relPath)) return true
  }
  return false
}

// ── walk ────────────────────────────────────────────────────────────────────

/** Recursively lists files under `root`, honouring exclude patterns, depth and file caps. */
export async function walk(root, cfg = {}) {
  const { exclude = [], maxDepth = 6, maxFiles = 20000 } = cfg
  const out = []

  async function visit(dir, depth) {
    if (out.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory — skip it, never throw
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (isExcluded(entry.name, rel, exclude)) continue
      if (entry.isDirectory()) {
        await visit(full, depth + 1)
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(full)
          out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          /* vanished or unreadable between readdir and stat — skip */
        }
      }
    }
  }

  await visit(root, 0)
  return out
}

// ── snapshot diff ───────────────────────────────────────────────────────────

/** Compares two `{ [path]: { size, mtimeMs } }` snapshots into a list of changes. */
export function diffSnapshot(prev, next) {
  const changes = []
  for (const [p, cur] of Object.entries(next)) {
    const was = prev[p]
    if (!was) {
      changes.push({ path: p, kind: 'added', bytesChanged: cur.size, size: cur.size, mtimeMs: cur.mtimeMs })
    } else if (was.size !== cur.size || was.mtimeMs !== cur.mtimeMs) {
      changes.push({
        path: p,
        kind: 'modified',
        bytesChanged: Math.abs(cur.size - was.size),
        size: cur.size,
        mtimeMs: cur.mtimeMs,
      })
    }
  }
  for (const [p, was] of Object.entries(prev)) {
    if (!next[p]) {
      changes.push({ path: p, kind: 'removed', bytesChanged: was.size, size: was.size, mtimeMs: was.mtimeMs })
    }
  }
  return changes
}

// ── Office author (hand-rolled zip read) ────────────────────────────────────

const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx', '.docm', '.xlsm', '.pptm'])

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Finds the End Of Central Directory record by scanning backwards for its signature. */
function findEocd(buf) {
  const maxBack = Math.min(buf.length, 65536 + 22)
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/** Reads `docProps/core.xml` out of an Office zip, by hand, without any zip dependency. */
function readCoreXml(buf) {
  const eocdOff = findEocd(buf)
  if (eocdOff < 0) return null
  const total = buf.readUInt16LE(eocdOff + 10)
  const cenOff = buf.readUInt32LE(eocdOff + 16)

  let off = cenOff
  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) return null
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localHeaderOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)

    if (name === 'docProps/core.xml') {
      if (buf.readUInt32LE(localHeaderOff) !== LOC_SIG) return null
      const locNameLen = buf.readUInt16LE(localHeaderOff + 26)
      const locExtraLen = buf.readUInt16LE(localHeaderOff + 28)
      const dataStart = localHeaderOff + 30 + locNameLen + locExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)
      if (method === 0) return raw.toString('utf8')
      if (method === 8) return zlib.inflateRawSync(raw).toString('utf8')
      return null // unsupported compression method
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/** `{ lastModifiedBy, modified }` from an Office file's core.xml, or nulls on any problem. */
export async function readOfficeAuthor(filePath) {
  const nulls = { lastModifiedBy: null, modified: null }
  const ext = path.extname(filePath).toLowerCase()
  if (!OFFICE_EXT.has(ext)) return nulls

  try {
    const buf = await fsp.readFile(filePath)
    const xml = readCoreXml(buf)
    if (!xml) return nulls

    const nameMatch = /<cp:lastModifiedBy>([\s\S]*?)<\/cp:lastModifiedBy>/.exec(xml)
    const modMatch = /<dcterms:modified[^>]*>([\s\S]*?)<\/dcterms:modified>/.exec(xml)

    const lastModifiedBy = nameMatch ? decodeXmlEntities(nameMatch[1].trim()) : null
    const modified = modMatch ? Date.parse(modMatch[1].trim()) : NaN

    return {
      lastModifiedBy: lastModifiedBy || null,
      modified: Number.isNaN(modified) ? null : modified,
    }
  } catch {
    return nulls // corrupt zip, unreadable file, whatever — never throw
  }
}

// ── ledger ──────────────────────────────────────────────────────────────────

const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13)

/** Folds `changes` into `ledger`, attributing each to `authors[path]` (or 'Unattributed'). */
export function applyChanges(ledger, changes, authors, now) {
  const next = structuredClone(ledger)
  const hour = hourKey(now)

  for (const change of changes) {
    const person = authors[change.path] || 'Unattributed'
    const existing = next[person]?.[change.path]

    // A removal never creates a fresh entry for a file nobody in the ledger already owns.
    if (change.kind === 'removed' && !existing) continue

    next[person] ??= {}
    const doc = (next[person][change.path] ??= {
      firstSeen: now,
      lastChange: now,
      changes: 0,
      bytesChanged: 0,
      hours: {},
    })

    doc.lastChange = now
    doc.changes += 1
    doc.bytesChanged += change.bytesChanged
    doc.hours[hour] ??= { changes: 0, bytes: 0 }
    doc.hours[hour].changes += 1
    doc.hours[hour].bytes += change.bytesChanged
  }

  return next
}

/** Who, per the ledger, currently owns `filePath` — the person(s) already tracking it. */
function ownersOf(ledger, filePath) {
  const owners = []
  for (const [person, docs] of Object.entries(ledger)) {
    if (docs[filePath]) owners.push(person)
  }
  return owners
}

// ── state I/O (atomic, mirrors server/api.mjs's colony.json writer) ─────────

const STATE_VERSION = 1

async function readState(statePath) {
  try {
    const raw = JSON.parse(await fsp.readFile(statePath, 'utf8'))
    return {
      version: STATE_VERSION,
      scannedAt: Number(raw.scannedAt) || 0,
      snapshot: raw.snapshot && typeof raw.snapshot === 'object' ? raw.snapshot : {},
      ledger: raw.ledger && typeof raw.ledger === 'object' ? raw.ledger : {},
    }
  } catch {
    return { version: STATE_VERSION, scannedAt: 0, snapshot: {}, ledger: {} }
  }
}

async function writeState(statePath, state) {
  await fsp.mkdir(path.dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp-${process.pid}`
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
  await fsp.rename(tmp, statePath)
}

// ── scan orchestration ───────────────────────────────────────────────────────

/**
 * Runs one scan pass over `cfg.roots`, updates the ledger and writes it back to `statePath`.
 *
 * Safety allowlist: `walk` is only ever called with a root taken verbatim from `cfg.roots` —
 * this function is the sole caller of `walk`, and it refuses any root not literally present
 * in `cfg.roots`, so a caller can't smuggle in an arbitrary directory through some other field.
 */
export async function runScan(cfg, statePath, { now = Date.now() } = {}) {
  const roots = cfg.roots
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('root not allowed: cfg.roots is empty')
  }
  for (const root of roots) {
    if (typeof root !== 'string' || !root) throw new Error(`root not allowed: ${String(root)}`)
    if (!roots.includes(root)) throw new Error(`root not allowed: ${root}`) // unreachable, but keeps the invariant explicit
  }

  const state = await readState(statePath)
  const walkCfg = { exclude: cfg.exclude, maxDepth: cfg.maxDepth, maxFiles: cfg.maxFiles }

  const files = []
  for (const root of roots) {
    files.push(...(await walk(root, walkCfg)))
  }

  const nextSnapshot = {}
  for (const f of files) nextSnapshot[f.path] = { size: f.size, mtimeMs: f.mtimeMs }

  const changes = diffSnapshot(state.snapshot, nextSnapshot)

  const authors = {}
  for (const change of changes) {
    if (change.kind === 'removed') continue
    authors[change.path] = (await readOfficeAuthor(change.path)).lastModifiedBy
  }

  // Removed files: attribute to whoever already owns them in the ledger (first owner found),
  // else Unattributed — there's no file left to read an author out of.
  const removalAuthors = {}
  for (const change of changes) {
    if (change.kind !== 'removed') continue
    const owners = ownersOf(state.ledger, change.path)
    removalAuthors[change.path] = owners[0] || null
  }

  const combinedAuthors = { ...authors, ...removalAuthors }
  const nextLedger = applyChanges(state.ledger, changes, combinedAuthors, now)

  await writeState(statePath, {
    version: STATE_VERSION,
    scannedAt: now,
    snapshot: nextSnapshot,
    ledger: nextLedger,
  })

  return {
    scannedAt: now,
    changes: changes.length,
    files: files.length,
    people: Object.keys(nextLedger).length,
  }
}
