/**
 * Zone keying: the precedence a thread's zone name is picked by, and the Windows drive-letter
 * case fold that keeps one real folder from splitting into two zones.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { projectKeyFor } from '../src/game/project-key.js'
import { liveThreadsForColony, hiddenCatalog } from '../src/game/hidden-projects.js'

test('a sidebar group beats a title prefix, which beats the repo name', () => {
  assert.equal(projectKeyFor({ group: 'Colony', title: 'Bot Crossing — WP2: Zones', project: 'bot-crossing' }), 'Colony')
  assert.equal(projectKeyFor({ title: 'Joey — WP3: Something', project: 'joey' }), 'Joey')
  assert.equal(projectKeyFor({ title: 'Untitled thread', project: 'bot-crossing' }), 'bot-crossing')
  assert.equal(projectKeyFor({}), 'unknown')
})

test('a title without the "<Project> — …" shape falls through to the repo', () => {
  assert.equal(projectKeyFor({ title: 'just a normal title', project: 'joey' }), 'joey')
})

test('a drive letter folds to one case, so the same folder never splits into two zones', () => {
  assert.equal(projectKeyFor({ project: 'c:\\Users\\b.edwards\\Documents\\Claude' }), 'C:\\Users\\b.edwards\\Documents\\Claude')
  assert.equal(projectKeyFor({ project: 'C:\\Users\\b.edwards\\Documents\\Claude' }), 'C:\\Users\\b.edwards\\Documents\\Claude')
  assert.equal(projectKeyFor({ project: 'c:/Users/b.edwards/Documents/Claude' }), 'C:/Users/b.edwards/Documents/Claude')
})

test('a plain repo name with no drive prefix is left alone', () => {
  assert.equal(projectKeyFor({ project: 'bot-crossing' }), 'bot-crossing')
})

test('hiding a zone hides the threads drawn in it, whichever rule named the zone', () => {
  // The HUD hides by the name on the plot, so the filter has to match on the same key —
  // a title-prefixed or grouped thread whose repo folder is called something else included.
  const ghost = { id: 'a', title: 'Bot Crossing — WP1: Legend', project: 'focused-banach-e27606' }
  const grouped = { id: 'b', group: 'Colony', title: 'anything', project: 'Claude' }
  const plain = { id: 'c', title: 'Excel macro', project: 'Claude' }
  const live = liveThreadsForColony([ghost, grouped, plain], [], ['Bot Crossing', 'Colony'])
  assert.deepEqual(live.map((t) => t.id), ['c'])
  assert.deepEqual(hiddenCatalog(['Bot Crossing', 'Colony'], [ghost, grouped, plain]), [
    { name: 'Bot Crossing', count: 1 },
    { name: 'Colony', count: 1 },
  ])
})
