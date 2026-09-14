/**
 * Share Crossing scanner — walk/diff/attribute/ledger, plus a hand-rolled zip reader for the
 * Office `lastModifiedBy` author. Fixture-driven: `writeDocx` builds a real (if minimal) zip
 * on disk so `readOfficeAuthor` is exercised against actual zip bytes, not a mock.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  applyChanges,
  defaultConfig,
  diffSnapshot,
  loadConfig,
  readOfficeAuthor,
  runScan,
  walk,
} from '../server/lib/share-scan.mjs'

// ── CRC32 + minimal zip writer ───────────────────────────────────────────────

function makeCrcTable() {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}
const CRC_TABLE = makeCrcTable()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Builds one local-file-header + data block, and returns it plus the matching central entry. */
function zipEntry(name, data, { deflate }) {
  const nameBuf = Buffer.from(name, 'utf8')
  const stored = deflate ? zlib.deflateRawSync(data) : data
  const method = deflate ? 8 : 0
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(0, 6) // flags
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(0, 10) // mod time
  local.writeUInt16LE(0, 12) // mod date
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(stored.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28) // extra len

  const localBlock = Buffer.concat([local, nameBuf, stored])

  return {
    localBlock,
    centralFor(offset) {
      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(20, 4) // version made by
      central.writeUInt16LE(20, 6) // version needed
      central.writeUInt16LE(0, 8) // flags
      central.writeUInt16LE(method, 10)
      central.writeUInt16LE(0, 12)
      central.writeUInt16LE(0, 14)
      central.writeUInt32LE(crc, 16)
      central.writeUInt32LE(stored.length, 20)
      central.writeUInt32LE(data.length, 24)
      central.writeUInt16LE(nameBuf.length, 28)
      central.writeUInt16LE(0, 30) // extra len
      central.writeUInt16LE(0, 32) // comment len
      central.writeUInt16LE(0, 34) // disk number
      central.writeUInt16LE(0, 36) // internal attrs
      central.writeUInt32LE(0, 38) // external attrs
      central.writeUInt32LE(offset, 42)
      return Buffer.concat([central, nameBuf])
    },
  }
}

function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data, deflate } of entries) {
    const e = zipEntry(name, data, { deflate })
    locals.push(e.localBlock)
    centrals.push(e.centralFor(offset))
    offset += e.localBlock.length
  }
  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(centrals)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([localBuf, centralBuf, eocd])
}

const CONTENT_TYPES = '<?xml version="1.0"?><Types></Types>'

function coreXml({ lastModifiedBy, modified }) {
  return (
    `<?xml version="1.0"?><cp:coreProperties xmlns:cp="cp" xmlns:dcterms="dcterms">` +
    `<cp:lastModifiedBy>${lastModifiedBy}</cp:lastModifiedBy>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified>` +
    `</cp:coreProperties>`
  )
}

/** Writes a minimal but real docx/xlsx-shaped zip: stored content-types, deflated core.xml. */
async function writeDocx(file, { lastModifiedBy, modified }) {
  const zip = buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8'), deflate: false },
    { name: 'docProps/core.xml', data: Buffer.from(coreXml({ lastModifiedBy, modified }), 'utf8'), deflate: true },
  ])
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, zip)
}

async function tmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

// ── readOfficeAuthor ─────────────────────────────────────────────────────────

test('readOfficeAuthor reads the name and modified time out of a real docx zip', async () => {
  const dir = await tmpDir('share-scan-')
  const file = path.join(dir, 'Site layout.docx')
  await writeDocx(file, { lastModifiedBy: 'Alice &amp; Bob', modified: '2026-09-01T10:00:00Z' })

  const result = await readOfficeAuthor(file)
  assert.equal(result.lastModifiedBy, 'Alice & Bob')
  assert.equal(result.modified, Date.parse('2026-09-01T10:00:00Z'))
  await fsp.rm(dir, { recursive: true, force: true })
})

test('readOfficeAuthor returns nulls for a non-Office file without reading it, and for a corrupt docx', async () => {
  const dir = await tmpDir('share-scan-')

  const txt = path.join(dir, 'notes.txt')
  await fsp.writeFile(txt, 'plain text, not a zip at all')
  assert.deepEqual(await readOfficeAuthor(txt), { lastModifiedBy: null, modified: null })

  const corrupt = path.join(dir, 'broken.docx')
  await fsp.writeFile(corrupt, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
  assert.deepEqual(await readOfficeAuthor(corrupt), { lastModifiedBy: null, modified: null })

  await fsp.rm(dir, { recursive: true, force: true })
})

// ── walk ─────────────────────────────────────────────────────────────────────

test('walk honours exclude patterns, maxDepth and maxFiles', async () => {
  const dir = await tmpDir('share-scan-')
  await fsp.writeFile(path.join(dir, 'keep.docx'), 'a')
  await fsp.writeFile(path.join(dir, '~$lock.docx'), 'b') // excluded by ~$*
  await fsp.mkdir(path.join(dir, 'Archive'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'Archive', 'old.docx'), 'c') // excluded by **/Archive/**

  const files = await walk(dir, { exclude: ['~$*', '*.tmp', '**/Archive/**'], maxDepth: 6, maxFiles: 20000 })
  assert.deepEqual(
    files.map((f) => path.basename(f.path)).sort(),
    ['keep.docx'],
  )

  // maxDepth: nest one level deeper than allowed and confirm it's not walked.
  const deepDir = await tmpDir('share-scan-depth-')
  let cur = deepDir
  for (let i = 0; i < 4; i++) {
    cur = path.join(cur, `d${i}`)
    await fsp.mkdir(cur, { recursive: true })
  }
  await fsp.writeFile(path.join(cur, 'deep.docx'), 'x')
  const shallow = await walk(deepDir, { exclude: [], maxDepth: 2, maxFiles: 20000 })
  assert.equal(shallow.length, 0)
  const allowed = await walk(deepDir, { exclude: [], maxDepth: 5, maxFiles: 20000 })
  assert.equal(allowed.length, 1)

  // maxFiles: cap the count even though more files exist.
  const manyDir = await tmpDir('share-scan-many-')
  for (let i = 0; i < 5; i++) await fsp.writeFile(path.join(manyDir, `f${i}.txt`), 'x')
  const capped = await walk(manyDir, { exclude: [], maxDepth: 6, maxFiles: 3 })
  assert.equal(capped.length, 3)

  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.rm(deepDir, { recursive: true, force: true })
  await fsp.rm(manyDir, { recursive: true, force: true })
})

// ── diffSnapshot ─────────────────────────────────────────────────────────────

test('diffSnapshot reports added, modified and removed with correct bytesChanged', () => {
  const prev = {
    '/a': { size: 100, mtimeMs: 1 },
    '/b': { size: 200, mtimeMs: 1 },
    '/c': { size: 50, mtimeMs: 1 },
  }
  const next = {
    '/a': { size: 100, mtimeMs: 1 }, // unchanged
    '/b': { size: 250, mtimeMs: 2 }, // modified, +50
    '/d': { size: 30, mtimeMs: 3 }, // added
    // /c removed
  }
  const changes = diffSnapshot(prev, next)
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c]))
  assert.equal(byPath['/a'], undefined)
  assert.equal(byPath['/b'].kind, 'modified')
  assert.equal(byPath['/b'].bytesChanged, 50)
  assert.equal(byPath['/d'].kind, 'added')
  assert.equal(byPath['/d'].bytesChanged, 30)
  assert.equal(byPath['/c'].kind, 'removed')
  assert.equal(byPath['/c'].bytesChanged, 50)
  assert.equal(changes.length, 3)
})

// ── applyChanges purity ──────────────────────────────────────────────────────

test('applyChanges does not mutate the input ledger', () => {
  const ledger = { Alice: { '/a': { firstSeen: 1, lastChange: 1, changes: 1, bytesChanged: 10, hours: {} } } }
  const snapshotBefore = JSON.stringify(ledger)
  const changes = [{ path: '/a', kind: 'modified', bytesChanged: 5, size: 15, mtimeMs: 2 }]
  const next = applyChanges(ledger, changes, { '/a': 'Alice' }, 1000)
  assert.equal(JSON.stringify(ledger), snapshotBefore)
  assert.notEqual(next, ledger)
  assert.equal(next.Alice['/a'].changes, 2)
})

// ── runScan / loadConfig ──────────────────────────────────────────────────────

test('runScan throws for empty roots, and loadConfig throws when roots is missing', async () => {
  const dir = await tmpDir('share-scan-')
  const statePath = path.join(dir, 'state.json')
  await assert.rejects(() => runScan({ ...defaultConfig(), roots: [] }, statePath), /root not allowed/)

  const configPath = path.join(dir, 'config.json')
  await fsp.writeFile(configPath, JSON.stringify({ exclude: [] }))
  await assert.rejects(() => loadConfig(configPath), /roots/)

  await fsp.rm(dir, { recursive: true, force: true })
})

test('runScan: first run, unchanged second run, then a rewritten file on the third', async () => {
  const dir = await tmpDir('share-scan-')
  const shareRoot = path.join(dir, 'share')
  const stateDir = path.join(dir, 'state')
  const statePath = path.join(stateDir, 'share-activity.json')

  const aliceFile = path.join(shareRoot, 'Alice', 'Site layout.docx')
  const bobFile = path.join(shareRoot, 'Bob', 'Conveyor BOM.xlsx')
  await writeDocx(aliceFile, { lastModifiedBy: 'Alice Example', modified: '2026-09-01T09:00:00Z' })
  await writeDocx(bobFile, { lastModifiedBy: 'Bob Example', modified: '2026-09-01T09:00:00Z' })

  const cfg = { ...defaultConfig(), roots: [shareRoot] }
  const t0 = Date.parse('2026-09-14T08:00:00Z')

  // First run — everything is 'added'.
  const first = await runScan(cfg, statePath, { now: t0 })
  assert.equal(first.changes, 2)
  assert.equal(first.files, 2)
  assert.equal(first.people, 2)
  assert.ok(fs.existsSync(statePath))

  const state1 = JSON.parse(await fsp.readFile(statePath, 'utf8'))
  assert.equal(Object.keys(state1.ledger).sort().join(','), 'Alice Example,Bob Example')
  const aliceSize = state1.ledger['Alice Example'][aliceFile].bytesChanged
  const aliceStat = await fsp.stat(aliceFile)
  assert.equal(aliceSize, aliceStat.size)

  // Second run — nothing changed on disk.
  const second = await runScan(cfg, statePath, { now: t0 + 1000 })
  assert.equal(second.changes, 0)
  const state2 = JSON.parse(await fsp.readFile(statePath, 'utf8'))
  assert.deepEqual(state2.ledger, state1.ledger)

  // Third run — rewrite Alice's file bigger, one hour later. Appending zero bytes after a
  // valid zip's EOCD is harmless to `readOfficeAuthor` (the EOCD scan looks backwards within
  // the trailing 64KB) and is the simplest way to grow the file by an exact, known amount.
  // Same author/date as the original write, so the zip bytes (and hence size) come out
  // identical before the append — isolating the size delta to exactly the appended bytes.
  const sizeBefore = (await fsp.stat(aliceFile)).size
  const t1 = t0 + 60 * 60 * 1000
  await writeDocx(aliceFile, { lastModifiedBy: 'Alice Example', modified: '2026-09-01T09:00:00Z' })
  await fsp.appendFile(aliceFile, Buffer.alloc(4096))
  const sizeAfter = (await fsp.stat(aliceFile)).size
  const third = await runScan(cfg, statePath, { now: t1 })
  assert.equal(third.changes, 1)
  assert.equal(sizeAfter - sizeBefore, 4096)

  const state3 = JSON.parse(await fsp.readFile(statePath, 'utf8'))
  const doc = state3.ledger['Alice Example'][aliceFile]
  assert.equal(doc.changes, 2)
  assert.equal(doc.bytesChanged, aliceSize + 4096, 'bytesChanged accumulates the size delta from the rewrite')
  assert.equal(Object.keys(doc.hours).length, 2, 'a new hour bucket appears once `now` moves into a new hour')

  await fsp.rm(dir, { recursive: true, force: true })
})
