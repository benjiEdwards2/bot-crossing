/**
 * Harness adapter: shared folders — file activity, not agent threads.
 *
 * There is no "session" here: `server/lib/share-scan.mjs` walks a set of network-share roots
 * and keeps a per-person, per-file ledger of who last touched what. This adapter turns that
 * ledger into one thread per (person, document), so a shared drive shows up on the map the same
 * way an agent harness does.
 *
 * `scanThreads()` must stay cheap — it only reads the state file the scanner already wrote.
 * The actual walk (`runScan`) is comparatively expensive (it touches every file under every
 * root), so it only runs when the state looks stale, and it runs in the background: this
 * function never awaits it. `refreshInFlight()` exists purely so tests (and `diagnostic()`) can
 * see it happening.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { exists } from '../lib/fsutil.mjs'
import { loadConfig, runScan } from '../lib/share-scan.mjs'

const CONFIG_PATH =
  process.env.BOT_CROSSING_SHARE_CONFIG || path.join(os.homedir(), 'Desktop', 'Claude', 'ShareCrossing', 'share-config.json')
const STATE_PATH =
  process.env.BOT_CROSSING_SHARE_STATE || path.join(path.dirname(CONFIG_PATH), 'data', 'share-activity.json')

/** Default `scanEveryMs`/`activeWindowMs` if the config doesn't say — an hour either way. */
const DEFAULT_SCAN_EVERY_MS = 60 * 60 * 1000
const DEFAULT_ACTIVE_WINDOW_MS = 60 * 60 * 1000

const ID = (raw) => `file-share:${raw}`

/** One id per (person, path) — stable across scans since it's derived from the pair itself. */
function threadId(person, docPath) {
  return ID(createHash('sha1').update(`${person}|${docPath}`).digest('hex').slice(0, 24))
}

async function readState() {
  try {
    const raw = JSON.parse(await fsp.readFile(STATE_PATH, 'utf8'))
    return {
      scannedAt: Number(raw.scannedAt) || 0,
      ledger: raw.ledger && typeof raw.ledger === 'object' ? raw.ledger : {},
    }
  } catch {
    return { scannedAt: 0, ledger: {} }
  }
}

/** What a file is and what it opens in, from its extension — the card's first words. */
const OPENS_IN = {
  '.docx': 'Word', '.docm': 'Word', '.doc': 'Word', '.rtf': 'Word',
  '.xlsx': 'Excel', '.xlsm': 'Excel', '.xlsb': 'Excel', '.xls': 'Excel', '.csv': 'Excel',
  '.pptx': 'PowerPoint', '.pptm': 'PowerPoint', '.ppt': 'PowerPoint',
  '.vsdx': 'Visio', '.msg': 'Outlook', '.one': 'OneNote', '.pdf': 'PDF reader',
  '.dwg': 'AutoCAD', '.dxf': 'AutoCAD', '.txt': 'Notepad', '.md': 'text editor',
  '.png': 'image viewer', '.jpg': 'image viewer', '.jpeg': 'image viewer',
}
export function describeFile(docPath) {
  const ext = path.extname(docPath).toLowerCase()
  if (!ext) return 'no extension'
  const app = OPENS_IN[ext]
  return app ? `${ext} · opens in ${app}` : ext
}

/** 437 B, 12.4 KB, 3.1 MB — the size a person would say, not a raw byte count. */
export function formatBytes(n) {
  const b = Number(n) || 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Pure: turns a ledger into threads. Exported so tests can exercise it without touching disk. */
export function threadsFromLedger(ledger, now, cfg) {
  const activeWindowMs = cfg?.activeWindowMs || DEFAULT_ACTIVE_WINDOW_MS
  const threads = []
  for (const [person, docs] of Object.entries(ledger || {})) {
    for (const [docPath, doc] of Object.entries(docs || {})) {
      const n = doc.changes || 0
      threads.push({
        id: threadId(person, docPath),
        title: path.basename(docPath),
        preview: `${describeFile(docPath)} · ${formatBytes(doc.bytesChanged)} changed · ${n} edit${n === 1 ? '' : 's'}`,
        project: person,
        projectPath: path.dirname(docPath),
        worktree: '',
        cwd: path.dirname(docPath),
        gitBranch: '',
        model: '',
        effort: '',
        createdAt: doc.firstSeen,
        lastActivityAt: doc.lastChange,
        lastFocusedAt: doc.lastChange,
        unread: false,
        running: now - doc.lastChange < activeWindowMs,
        hasError: false,
        starred: false,
        routine: false,
        prState: null,
        archived: false,
        sizeBytes: doc.bytesChanged,
        source: 'file-share',
        canOpen: true,
        group: person,
        ref: { path: docPath },
      })
    }
  }
  return threads
}

/**
 * The background refresh, if one is running — kept here so a second `scanThreads()` call
 * doesn't start a second walk, and so tests/`diagnostic()` can see it and await it.
 */
let inFlight = null
let lastRefreshError = ''

/** Non-null while a background `runScan` is in progress. Never awaited by `scanThreads()`. */
export function refreshInFlight() {
  return inFlight
}

function maybeStartRefresh(state, cfg, now) {
  if (inFlight || !cfg) return
  if (now - state.scannedAt <= (cfg.scanEveryMs || DEFAULT_SCAN_EVERY_MS)) return
  // Decided synchronously once the config is in hand, so a caller that checks
  // `refreshInFlight()` straight after `scanThreads()` sees exactly what was started.
  inFlight = runScan(cfg, STATE_PATH, { now })
    .then(() => {
      lastRefreshError = ''
    })
    .catch((err) => {
      lastRefreshError = err?.message || String(err)
    })
    .finally(() => {
      inFlight = null
    })
}

async function scanThreads() {
  const now = Date.now()
  const state = await readState()
  const cfg = await loadConfig(CONFIG_PATH).catch((err) => {
    lastRefreshError = err?.message || String(err)
    return null
  })
  maybeStartRefresh(state, cfg, now)
  return threadsFromLedger(state.ledger, now, cfg)
}

/** Reveal the containing folder — never the file itself, so nothing is silently launched. */
function revealFolder(dir) {
  if (process.env.NODE_TEST_CONTEXT) return { ok: true } // never actually spawn Explorer in tests
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [dir], { stdio: 'ignore', detached: true }).unref()
    } else {
      spawn('xdg-open', [dir], { stdio: 'ignore', detached: true }).unref()
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

async function openThread(ref) {
  const p = ref?.path
  if (typeof p !== 'string' || !p) return { ok: false, error: 'No path on that thread' }

  const cfg = await loadConfig(CONFIG_PATH).catch(() => null)
  const roots = cfg?.roots || []
  const resolved = path.resolve(p)
  const underRoot = roots.some((r) => resolved.startsWith(path.resolve(r) + path.sep) || resolved === path.resolve(r))
  if (!underRoot) return { ok: false, error: 'That path is not under a configured share root' }

  return revealFolder(path.dirname(resolved))
}

/** Shared folders have no sessions to start — say so, per the README's contract for adapters
 *  with no deep link, rather than pretending a click did something. */
function newSession() {
  return { ok: false, error: 'Shared folders have no sessions to start' }
}

async function diagnostic() {
  const cfg = await loadConfig(CONFIG_PATH).catch((err) => null)
  const state = await readState()
  const people = Object.keys(state.ledger).length
  const files = Object.values(state.ledger).reduce((n, docs) => n + Object.keys(docs).length, 0)
  const ageMs = state.scannedAt ? Date.now() - state.scannedAt : -1
  const parts = [
    `config: ${CONFIG_PATH}`,
    `roots: ${cfg?.roots?.length ?? 0}`,
    `files: ${files}`,
    `people: ${people}`,
    `scannedAt age: ${ageMs < 0 ? 'never' : `${Math.round(ageMs / 1000)}s`}`,
  ]
  if (lastRefreshError) parts.push(`last refresh error: ${lastRefreshError}`)
  return parts.join(' · ')
}

const detect = () => exists(CONFIG_PATH)

export default {
  id: 'file-share',
  name: 'Shared folders',
  detect,
  scanThreads,
  openThread,
  newSession,
  diagnostic,
  paths: { CONFIG_PATH, STATE_PATH },
}
