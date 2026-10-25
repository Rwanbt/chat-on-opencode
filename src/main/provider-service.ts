import path from 'node:path';
import { realpathSync } from 'node:fs';

/** The provider runtime is opt-in and MUST NOT silently reuse CoS's personal userData. */
export const PROVIDER_SERVICE_SWITCH = '--chat-on-opencode-provider-service';

export function providerServiceProfile(argv: readonly string[], supplied: string | undefined, normalUserData: string): string | null {
  if (!argv.includes(PROVIDER_SERVICE_SWITCH)) return null;
  if (!supplied || !path.isAbsolute(supplied) || !path.isAbsolute(normalUserData)) {
    throw new Error('provider_service_requires_isolated_absolute_userdata');
  }
  // A missing profile is refused rather than made inside an unexpected personal folder.
  // Canonical paths close symlink/junction aliases before the Electron process starts.
  let profile: string;
  let personal: string;
  try {
    profile = realpathSync(path.resolve(supplied));
    personal = realpathSync(path.resolve(normalUserData));
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

export function providerServiceReady(config: { ui: { chatBrowser?: string }; controlApi: { enabled: boolean; allowActions: boolean } }): boolean {
  return config.ui.chatBrowser === 'cos' && config.controlApi.enabled === true && config.controlApi.allowActions === true;
}
