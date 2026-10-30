/** The promotion transition entry point.
 *
 * The transition is the only path that may publish a promotion. It is gated by
 * `PROMOTION_ALLOWED`, a module constant that stays `false` until a human
 * authorises the transition itself (ADR-0003). Options are never consulted for
 * the gate, so a caller cannot open it by passing a value.
 *
 * While the gate is closed the function refuses before it reads or writes any
 * file, and returns the same machine-readable shape every time.
 */
export const PROMOTION_ALLOWED = false

export function runPromotionTransition() {
  if (PROMOTION_ALLOWED !== true) {
    return Object.freeze({
      status: 'NO_GO',
      reason: 'promotion_not_allowed',
      promotionAllowed: false,
      activationAuthorized: false,
      changed: false,
    })
  }
  throw Error('promotion_transition_not_implemented')
}
