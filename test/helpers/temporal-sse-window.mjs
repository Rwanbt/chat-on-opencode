/** A bounded observation interval, not a correlation to any GUI message or turn. */
export function temporalSseWindow(before, after) {
  const frames = Math.max(0, after.frames - before.frames)
  return {
    correlation:'temporal_uncorrelated',
    frames,
    responses:Math.max(0, after.responses - before.responses),
    elapsedMs:frames && before.lastAt !== null && after.lastAt !== null
      ? Math.max(0, after.lastAt - before.lastAt) : 0,
  }
}
