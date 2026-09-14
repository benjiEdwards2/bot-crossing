/**
 * The deck-clutter slider's thinning rule: what a density keeps, and the monotonicity that
 * stops a deck reshuffling as the slider moves.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { keepClutter, clutterSubset } from '../src/world/clutter-density.js'

const props = [0.02, 0.29, 0.3, 0.31, 0.59, 0.6, 0.61, 0.999].map((rank, i) => ({ id: i, rank }))

test('density 1 keeps every prop, the highest rank included', () => {
  assert.equal(keepClutter(0.999, 1), true)
  assert.equal(keepClutter(0, 1), true)
  assert.deepEqual(clutterSubset(props, 1), props)
})

test('density 0 keeps nothing, the lowest rank included', () => {
  assert.equal(keepClutter(0, 0), false)
  assert.deepEqual(clutterSubset(props, 0), [])
})

test('lowering the density only ever removes props', () => {
  const thin = clutterSubset(props, 0.3)
  const thick = clutterSubset(props, 0.6)
  assert.deepEqual(thin.map((p) => p.id), [0, 1])
  assert.deepEqual(thick.map((p) => p.id), [0, 1, 2, 3, 4])
  for (const p of thin) assert.ok(thick.includes(p), `rank ${p.rank} dropped out on the way down`)
})

test('the same list at the same density gives the same props', () => {
  assert.deepEqual(clutterSubset(props, 0.45), clutterSubset(props, 0.45))
})
