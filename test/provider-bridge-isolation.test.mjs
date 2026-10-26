import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeDiscoveryPlan, firstResponsiveBridge } from '../extension/bridge-discovery.mjs';
import { providerBrowserDiscoveryPolicy, PROVIDER_SERVICE_SWITCH, PROVIDER_SIGN_IN_SWITCH } from '../src/main/provider-service.ts';

const NORMAL_PORTS = [8765, 8766, 8767];

test('provider service and isolated sign-in use only their own published bridge port', async () => {
  for (const mode of [PROVIDER_SERVICE_SWITCH, PROVIDER_SIGN_IN_SWITCH]) {
    const policy = providerBrowserDiscoveryPolicy(['provider.exe', mode], 8766);
    const { candidates, forgetCredential } = bridgeDiscoveryPlan(policy, NORMAL_PORTS, 8765);
    assert.equal(forgetCredential, true, 'old personal bridge pairing must not be sent to provider');
    const contacted = [];
    const found = await firstResponsiveBridge(candidates, async candidate => {
      contacted.push(candidate);
      return { app: candidate === 8765 ? 'personal-cos' : 'isolated-provider' };
    });
    assert.deepEqual(contacted, [8766], 'the personal CoS listener on 8765 must never receive hello or pairing');
    assert.deepEqual(found, { port: 8766, response: { app: 'isolated-provider' } });
  }
});

test('unpublished or invalid provider port fails closed without falling back to a personal listener', () => {
  for (const port of [null, 0, -1, 8765, 8767, 18766, 65536, 3.14, '8766']) {
    const policy = providerBrowserDiscoveryPolicy(['app.exe', PROVIDER_SERVICE_SWITCH], port);
    assert.deepEqual(bridgeDiscoveryPlan(policy, NORMAL_PORTS, 8765), { candidates: [], forgetCredential: true });
  }
  // A temporary native IPC failure cannot delete the regular CoS browser's pairing.
  assert.deepEqual(bridgeDiscoveryPlan(null, NORMAL_PORTS, 8765), { candidates: [], forgetCredential: false });
});

test('ordinary CoS and Chrome companion retain their existing discovery ports', () => {
  const normal = providerBrowserDiscoveryPolicy(['app.exe'], 8766);
  assert.deepEqual(bridgeDiscoveryPlan(normal, NORMAL_PORTS, 8765), {
    candidates: NORMAL_PORTS, forgetCredential: false,
  });
});
