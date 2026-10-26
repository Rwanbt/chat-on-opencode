/** The trusted Electron host pins isolated provider workers to their own bridge.
 * An unavailable or malformed policy never permits a scan of someone else's CoS. */
export function bridgeDiscoveryPlan(policy, usualPorts, rememberedPort) {
  let candidates = [];
  if (policy?.scope === 'normal') candidates = usualPorts;
  else if (policy?.scope === 'provider' && Number.isInteger(policy.port) &&
    policy.port >= 1 && policy.port <= 65535) candidates = [policy.port];
  return { candidates, forgetCredential: policy?.scope === 'provider' &&
    rememberedPort !== null && !candidates.includes(rememberedPort) };
}

/** Executes only native-authorized candidates, even when other local apps answer first. */
export async function firstResponsiveBridge(candidates, hello) {
  for (const port of candidates) {
    const response = await hello(port);
    if (response) return { port, response };
  }
  return null;
}
