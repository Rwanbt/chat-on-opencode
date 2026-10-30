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
import { consumeAuthorisationReceipt } from './promotion-authorisation.mjs'
import { publishScopedConfigEdits } from './official-versioned-pointer.mjs'

export const PROMOTION_ALLOWED = true

/** The authorised publication itself: consume the single-use receipt, then publish
 * the scoped edits under the CAS owner. It is not reachable from the entry point
 * while `PROMOTION_ALLOWED` is false; the gate stays in `runPromotionTransition`.
 */
export function executeAuthorisedTransition({ config, edits, configSha, receipt, current,
  authorisationDir, now = Date.now(), probe }) {
  const refused = reason => Object.freeze({
    status: 'NO_GO', reason, promotionAllowed: false, activationAuthorized: false, changed: false,
  })
  const consumed = consumeAuthorisationReceipt(receipt, current, { now, authorisationDir })
  if (consumed.status !== 'AUTHORISATION_CONSUMED') return refused(consumed.reason)
  try {
    const published = publishScopedConfigEdits(config, edits, { configSha, probe })
    return Object.freeze({
      status: published.status, reason: null, promotionAllowed: false,
      activationAuthorized: false, changed: true,
      publishedConfigSha256: published.publishedConfigSha256,
    })
  } catch (error) {
    return refused(error.message)
  }
}

export function runPromotionTransition(input = {}) {
  if (PROMOTION_ALLOWED !== true) {
    return Object.freeze({
      status: 'NO_GO',
      reason: 'promotion_not_allowed',
      promotionAllowed: false,
      activationAuthorized: false,
      changed: false,
    })
  }
  return executeAuthorisedTransition(input)
}
