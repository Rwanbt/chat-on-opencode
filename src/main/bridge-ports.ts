import { BROWSER_BRIDGE_AUTO_PORTS, type BrowserBridgePort } from '../shared/browser-bridge.js';
import { PROVIDER_SERVICE_SWITCH, PROVIDER_SIGN_IN_SWITCH } from './provider-service.js';

/** Keep the existing environment/test override, including OS-assigned port 0. */
export function bridgePortSelection(choice: BrowserBridgePort = 'auto', raw = process.env.CLF_BRIDGE_PORTS,
  argv: readonly string[] = process.argv): {
  candidates: readonly number[]; overridden: boolean;
} {
  // An isolated provider never binds the personal CoS port, even if 8765
  // happens to be free or a stale environment override names it. Port 8766
  // being occupied is a hard failure: no fallback to another application's port.
  if (argv.includes(PROVIDER_SERVICE_SWITCH) || argv.includes(PROVIDER_SIGN_IN_SWITCH)) {
    return { candidates: [8766], overridden: true };
  }
  const parsed = (raw ?? '').split(',').map(part => Number.parseInt(part.trim(), 10))
    .filter(value => Number.isInteger(value) && value >= 0 && value <= 65535);
  if (parsed.length) return { candidates: parsed, overridden: true };
  return { candidates: choice === 'auto' ? BROWSER_BRIDGE_AUTO_PORTS : [choice], overridden: false };
}
