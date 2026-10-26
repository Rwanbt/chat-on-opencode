import path from 'node:path';
import { realpathSync } from 'node:fs';

/** The provider runtime is opt-in and MUST NOT silently reuse CoS's personal userData. */
export const PROVIDER_SERVICE_SWITCH = '--chat-on-opencode-provider-service';
/** Explicit one-time user action: the same isolated profile, with a visible ChatGPT sign-in. */
export const PROVIDER_SIGN_IN_SWITCH = '--chat-on-opencode-provider-sign-in';

/** Chromium tabs remain offscreen in provider mode; no CoS GUI may be revealed. */
export function providerBrowserUiAllowed(argv: readonly string[]): boolean {
  return !argv.includes(PROVIDER_SERVICE_SWITCH) || argv.includes(PROVIDER_SIGN_IN_SWITCH);
}

/** Both isolated modes must discover only the bridge opened by this Electron process.
 * A missing listener fails closed, including when the user's personal CoS is live. */
export function providerBrowserDiscoveryPolicy(argv: readonly string[], bridgePort: unknown):
  { scope: 'normal' } | { scope: 'provider'; port: number | null } {
  if (!argv.includes(PROVIDER_SERVICE_SWITCH) && !argv.includes(PROVIDER_SIGN_IN_SWITCH)) return { scope: 'normal' };
  // A provider bridge on any other port must fail closed; 8765 belongs to the
  // person's CoS and even a native host regression cannot authorize scanning it.
  return { scope: 'provider', port: bridgePort === 8766 ? 8766 : null };
}

/** The hidden helper has no sign-in window or ordinary browser tabs. A single
 * offscreen ChatGPT page starts the extension's normal document/bridge lifecycle.
 * The browser host owns its session and its reveal:false presentation gate. */
export async function bootstrapProviderBrowserTab(argv: readonly string[], browser: {
  start(): Promise<void>;
  control: { model: { query(options: { url: string }): readonly unknown[] } };
  open(url: string, options: { reveal: boolean }): Promise<void>;
}): Promise<boolean> {
  if (!argv.includes(PROVIDER_SERVICE_SWITCH) || argv.includes(PROVIDER_SIGN_IN_SWITCH)) return false;
  await browser.start();
  if (browser.control.model.query({ url: 'https://chatgpt.com/*' }).length) return false;
  await browser.open('https://chatgpt.com/', { reveal: false });
  return true;
}

/** An orphaned helper must never keep Chromium and its private control API alive. */
export function providerServiceOwner(raw: string | undefined, currentPID = process.pid): number {
  const value = Number(raw);
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 2 || value === currentPID) {
    throw new Error('provider_service_gateway_owner_required');
  }
  return value;
}

export function providerServiceOwnerAlive(pid: number, probe: (pid: number, signal: 0) => void = process.kill): boolean {
  try { probe(pid, 0); return true; } catch { return false; }
}

/** Canonicalize an absent *personal* path without creating a personal CoS profile. */
export function prospectiveRealPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  const missing: string[] = [];
  let cursor = resolved;
  for (;;) {
    try { return path.join(realpathSync(cursor), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (cursor === parent) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function providerServiceProfile(argv: readonly string[], supplied: string | undefined, normalUserData: string): string | null {
  if (!argv.includes(PROVIDER_SERVICE_SWITCH) && !argv.includes(PROVIDER_SIGN_IN_SWITCH)) return null;
  if (argv.includes(PROVIDER_SERVICE_SWITCH) && argv.includes(PROVIDER_SIGN_IN_SWITCH)) {
    throw new Error('provider_service_conflicting_modes');
  }
  if (!supplied || !path.isAbsolute(supplied) || !path.isAbsolute(normalUserData)) {
    throw new Error('provider_service_requires_isolated_absolute_userdata');
  }
  // A missing profile is refused rather than made inside an unexpected personal folder.
  // Canonical paths close symlink/junction aliases before the Electron process starts.
  let profile: string;
  let personal: string;
  try {
    profile = realpathSync(path.resolve(supplied));
    personal = prospectiveRealPath(normalUserData);
  } catch {
    throw new Error('provider_service_profile_must_exist');
  }
  const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  // Never treat the regular CoS profile or its ancestor/descendant as a service profile.
  const a = comparable(profile);
  const b = comparable(personal);
  if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
    throw new Error('provider_service_profile_overlaps_personal_userdata');
  }
  if (profile === path.parse(profile).root) throw new Error('provider_service_profile_cannot_be_root');
  return profile;
}

/** A cookie is a local hint, never proof ChatGPT accepted the login or granted model access. */
export function providerReadinessStatus(cookie: boolean | null, bridge: {
  running: boolean; paired: boolean; cosExtension?: { present: boolean };
}): { sessionCookie: 'present' | 'absent' | 'unknown'; extension: 'connected' | 'disconnected';
  paired: boolean; canAttempt: boolean } {
  return {
    sessionCookie: cookie === null ? 'unknown' : cookie ? 'present' : 'absent',
    extension: bridge.running && bridge.cosExtension?.present === true ? 'connected' : 'disconnected',
    paired: bridge.paired,
    canAttempt: cookie === true && bridge.running && bridge.paired && bridge.cosExtension?.present === true
  };
}

export function providerServiceReady(config: { ui: { chatBrowser?: string }; controlApi: { enabled: boolean; allowActions: boolean } }): boolean {
  return config.ui.chatBrowser === 'cos' && config.controlApi.enabled === true && config.controlApi.allowActions === true;
}
