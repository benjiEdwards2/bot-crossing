/**
 * Which decorative props survive the deck-clutter slider.
 *
 * Split out of `plots.js` so it can be unit-tested directly: that module pulls in THREE and the
 * whole Vite graph and cannot be imported under a plain Node test runner, the same reason
 * `src/game/project-key.js` sits on its own.
 *
 * Every prop is dealt a fixed rank in [0,1) once, when the plot is built, and the slider is a
 * threshold on it. Thinning is therefore *monotone* — turning the density down only ever takes
 * props away, never rearranges the ones that stay — so a deck settles rather than reshuffling
 * as the slider moves.
 */

/** Keep a prop whose fixed rank is `rank` at this density. 1 keeps everything, 0 nothing. */
export function keepClutter(rank, density) {
  return rank < density
}

/** The props of `items` (each `{ rank }`) that survive at this density, in their original order. */
export function clutterSubset(items, density) {
  return items.filter((it) => keepClutter(it.rank, density))
}
