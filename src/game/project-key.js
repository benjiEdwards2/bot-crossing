/**
 * Which zone a thread belongs to.
 *
 * Split out of `colony.js` so it can be unit-tested directly: that module pulls in the whole
 * THREE/Vite graph and cannot be imported under a plain Node test runner, but this logic has
 * no such dependencies.
 *
 * Precedence: the desktop app's own sidebar group, when the harness could resolve one, beats
 * everything else — it is the grouping B. actually curates by hand. Failing that, sessions
 * titled "<Project> — WP<n>: <Name>" (or "<Project> — Coordinator") bunch under that project
 * name, since a mega-folder of desktop sessions otherwise all shares one repo. Everything else
 * keeps the repo name the scan found.
 */
export function projectKeyFor(thread) {
  const m = /^\s*(.{1,40}?)\s+[—–]\s+\S/.exec(thread.title || '')
  const prefix = m && m[1].trim()
  const key = thread.group || prefix || thread.project || 'unknown'
  // A Windows drive letter arrives in whatever case the session recorded its cwd in — "c:" and
  // "C:" are the same drive — so without this a single real folder can split across two zones.
  return /^[A-Za-z]:[\\/]/.test(key) ? key[0].toUpperCase() + key.slice(1) : key
}
