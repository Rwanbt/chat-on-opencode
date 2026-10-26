/** Only this local CoS gateway uses HTTP 503 for missing sign-in/bridge readiness.
 * Retrying an unauthenticated turn can never create consent or connect the browser.
 * Leave all other provider/model decisions and native SIWC policy untouched. */
export function stopUnavailableGatewayRetry(event) {
  if (event?.model?.providerID !== 'chat-on-opencode' ||
    event?.error?.status !== 503) return false
  event.decision = { retry: false }
  return true
}
