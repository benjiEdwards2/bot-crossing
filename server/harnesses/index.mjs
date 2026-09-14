/**
 * The harness registry.
 *
 * Adding support for another agent harness means writing one module next to this file and
 * adding it to the list below. Nothing else in the codebase needs to change — the scanner,
 * the API and the browser all talk to harnesses only through the interface documented in
 * `server/harnesses/README.md`.
 */
import claudeCode from './claude-code.mjs'
import codex from './codex.mjs'
import cursor from './cursor.mjs'
import fileShare from './file-share.mjs'

export const HARNESSES = [claudeCode, codex, cursor, fileShare]

export const harnessById = (id) => HARNESSES.find((h) => h.id === id) || null

/**
 * Which harnesses have data on this machine. Detection is per-scan rather than cached at
 * boot so that installing one while the colony is running is picked up on the next poll.
 *
 * `BOT_CROSSING_HARNESSES`, if set, narrows this to a comma-separated allowlist of ids — a
 * single-purpose instance (say, a shared-folder colony) shouldn't also surface your personal
 * Claude Code or Codex sessions just because they happen to be installed on the same machine.
 */
export async function detectedHarnesses() {
  const allowlist = process.env.BOT_CROSSING_HARNESSES
    ? new Set(process.env.BOT_CROSSING_HARNESSES.split(',').map((id) => id.trim()))
    : null
  const candidates = allowlist ? HARNESSES.filter((h) => allowlist.has(h.id)) : HARNESSES
  const flags = await Promise.all(
    candidates.map(async (h) => {
      try {
        return await h.detect()
      } catch {
        return false
      }
    })
  )
  return candidates.filter((_, i) => flags[i])
}
