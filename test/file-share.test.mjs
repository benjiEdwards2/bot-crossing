/**
 * Harness adapter: shared folders — built on the Phase 1 ledger, with a state file it only
 * reads (the actual walk is `runScan`'s job, exercised in `test/share-scan.test.mjs`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// ── fixture ───────────────────────────────────────────────────────────────────

async function fakeShare({ scannedAt, ledger }) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-share-fixture-'))
  const shareRoot = path.join(home, 'share')
  await fsp.mkdir(shareRoot, { recursive: true })

  const configPath = path.join(home, 'share-config.json')
  await fsp.writeFile(configPath, JSON.stringify({ roots: [shareRoot] }))

  const statePath = path.join(home, 'data', 'share-activity.json')
  await fsp.mkdir(path.dirname(statePath), { recursive: true })
  await fsp.writeFile(statePath, JSON.stringify({ version: 1, scannedAt, snapshot: {}, ledger }))

  return { home, shareRoot, configPath, statePath }
}

async function loadAdapter(configPath, statePath) {
  process.env.BOT_CROSSING_SHARE_CONFIG = configPath
  process.env.BOT_CROSSING_SHARE_STATE = statePath
  process.env.NODE_TEST_CONTEXT = '1' // never actually spawn Explorer/xdg-open from a test
  const mod = await import(`../server/harnesses/file-share.mjs?${configPath}`)
  return { ...mod.default, refreshInFlight: mod.refreshInFlight, threadsFromLedger: mod.threadsFromLedger }
}

function ledgerFixture(now) {
  const oldChange = now - 5 * 60 * 60 * 1000 // well outside the 1h active window
  const recentChange = now - 60 * 1000 // well inside it
  return {
    'Alice Example': {
      '/share/Alice/Site layout.docx': {
        firstSeen: oldChange,
        lastChange: recentChange,
        changes: 3,
        bytesChanged: 2 * 1024 * 1024,
        hours: {},
      },
    },
    'Bob Example': {
      '/share/Bob/Conveyor BOM.xlsx': {
        firstSeen: oldChange,
        lastChange: oldChange,
        changes: 1,
        bytesChanged: 512,
        hours: {},
      },
    },
    Unattributed: {
      '/share/Bob/notes.txt': {
        firstSeen: oldChange,
        lastChange: oldChange,
        changes: 1,
        bytesChanged: 29,
        hours: {},
      },
    },
  }
}

// ── detect ────────────────────────────────────────────────────────────────────

test('detect is true with a config file present, false without one', async () => {
  const { home, configPath, statePath } = await fakeShare({ scannedAt: Date.now(), ledger: {} })
  const h = await loadAdapter(configPath, statePath)
  assert.equal(await h.detect(), true)

  await fsp.rm(configPath)
  const h2 = await loadAdapter(configPath, statePath)
  assert.equal(await h2.detect(), false)
  await fsp.rm(home, { recursive: true, force: true })
})

// ── scanThreads shape ─────────────────────────────────────────────────────────

test('scanThreads returns one thread per (person, document), fresh state, no background refresh', async () => {
  const now = Date.now()
  const ledger = ledgerFixture(now)
  const { home, configPath, statePath } = await fakeShare({ scannedAt: now, ledger })
  const h = await loadAdapter(configPath, statePath)

  const threads = await h.scanThreads()
  assert.equal(threads.length, 3)

  const ids = threads.map((t) => t.id)
  assert.equal(new Set(ids).size, 3, 'ids are unique')
  for (const id of ids) assert.match(id, /^file-share:/)

  const byPath = Object.fromEntries(threads.map((t) => [t.ref.path, t]))
  const alice = byPath['/share/Alice/Site layout.docx']
  assert.equal(alice.group, 'Alice Example')
  assert.equal(alice.project, 'Alice Example')
  assert.equal(alice.sizeBytes, 2 * 1024 * 1024)
  assert.equal(alice.running, true, 'changed a minute ago — inside the active window')

  const bob = byPath['/share/Bob/Conveyor BOM.xlsx']
  assert.equal(bob.running, false, 'changed hours ago — outside the active window')
  assert.equal(bob.group, 'Bob Example')

  const unattributed = byPath['/share/Bob/notes.txt']
  assert.equal(unattributed.group, 'Unattributed')

  // Fresh state — no refresh should have been kicked off.
  assert.equal(h.refreshInFlight(), null)
  await fsp.rm(home, { recursive: true, force: true })
})

// ── stale state triggers a background refresh ────────────────────────────────

test('stale scannedAt returns the old threads immediately and starts a background refresh', async () => {
  const now = Date.now()
  const ledger = ledgerFixture(now)
  const { home, shareRoot, configPath, statePath } = await fakeShare({ scannedAt: 0, ledger })
  await fsp.mkdir(path.join(shareRoot, 'Alice'), { recursive: true }) // nothing to walk, but the root must exist
  const h = await loadAdapter(configPath, statePath)

  const threads = await h.scanThreads()
  assert.equal(threads.length, 3, 'returns immediately with the old ledger, not empty')

  const refresh = h.refreshInFlight()
  assert.notEqual(refresh, null, 'a background refresh was started')
  await refresh

  const state = JSON.parse(await fsp.readFile(statePath, 'utf8'))
  assert.ok(state.scannedAt > 0, 'scannedAt was updated by the background scan')
  assert.equal(h.refreshInFlight(), null, 'cleared once the refresh settles')

  await fsp.rm(home, { recursive: true, force: true })
})

// ── missing state file ────────────────────────────────────────────────────────

test('a missing state file yields no threads and never throws', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-share-fixture-'))
  const shareRoot = path.join(home, 'share')
  await fsp.mkdir(shareRoot, { recursive: true })
  const configPath = path.join(home, 'share-config.json')
  await fsp.writeFile(configPath, JSON.stringify({ roots: [shareRoot] }))
  const statePath = path.join(home, 'data', 'share-activity.json') // never written

  const h = await loadAdapter(configPath, statePath)
  const threads = await h.scanThreads()
  assert.deepEqual(threads, [])

  const refresh = h.refreshInFlight()
  if (refresh) await refresh // let the background scan settle before cleanup
  await fsp.rm(home, { recursive: true, force: true })
})

// ── openThread ────────────────────────────────────────────────────────────────

test('openThread refuses a path outside the configured roots', async () => {
  const now = Date.now()
  const { home, configPath, statePath } = await fakeShare({ scannedAt: now, ledger: {} })
  const h = await loadAdapter(configPath, statePath)

  const outside = await h.openThread({ path: path.join(os.tmpdir(), 'elsewhere', 'file.docx') })
  assert.equal(outside.ok, false)

  await fsp.rm(home, { recursive: true, force: true })
})

test('openThread accepts a path under a configured root', async () => {
  const now = Date.now()
  const { home, shareRoot, configPath, statePath } = await fakeShare({ scannedAt: now, ledger: {} })
  const h = await loadAdapter(configPath, statePath)

  const inside = await h.openThread({ path: path.join(shareRoot, 'Alice', 'Site layout.docx') })
  assert.equal(inside.ok, true)

  await fsp.rm(home, { recursive: true, force: true })
})

// ── newSession ────────────────────────────────────────────────────────────────

test('newSession says shared folders have none to start', async () => {
  const now = Date.now()
  const { home, configPath, statePath } = await fakeShare({ scannedAt: now, ledger: {} })
  const h = await loadAdapter(configPath, statePath)

  const result = await h.newSession('/tmp/whatever')
  assert.equal(result.ok, false)
  assert.match(result.error, /no sessions to start/i)

  await fsp.rm(home, { recursive: true, force: true })
})
