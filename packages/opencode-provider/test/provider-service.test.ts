import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerServiceProfile, prospectiveRealPath, providerServiceOwner, providerServiceOwnerAlive, providerBrowserUiAllowed, providerServiceReady, PROVIDER_SERVICE_SWITCH } from '../../../src/main/provider-service.js';

describe('standalone provider service admission', () => {
  it('keeps CoS windows and extension popup hidden only in provider mode', () => {
    expect(providerBrowserUiAllowed(['app.exe'])).toBeTrue();
    expect(providerBrowserUiAllowed(['app.exe', '--background'])).toBeTrue();
    expect(providerBrowserUiAllowed(['app.exe', PROVIDER_SERVICE_SWITCH])).toBeFalse();
  });
  it('requires a different, living gateway owner PID, without guessing', () => {
    expect(providerServiceOwner('123456', 42)).toBe(123456);
    for (const pid of [undefined, '0', '-1', 'NaN', '41.5', '42']) {
      expect(() => providerServiceOwner(pid, 42)).toThrow(/gateway_owner_required/);
    }
    expect(providerServiceOwnerAlive(123, () => undefined)).toBeTrue();
    expect(providerServiceOwnerAlive(123, () => { throw new Error('ESRCH'); })).toBeFalse();
  });
  const create = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'chat-on-opencode-'));
    const personal = path.join(root, 'existing-cos-userdata');
    const isolated = path.join(root, 'provider-userdata');
    mkdirSync(personal);
    mkdirSync(isolated);
    return { root, personal, isolated };
  };

  it('is inert in normal CoS launches, even with service environment set', () => {
    const { root, personal, isolated } = create();
    try {
      expect(providerServiceProfile(['app.exe'], isolated, personal)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('admits only an existing dedicated absolute profile', () => {
    const { root, personal, isolated } = create();
    try {
      const launch = ['app.exe', PROVIDER_SERVICE_SWITCH];
      expect(providerServiceProfile(launch, isolated, personal)).toBe(isolated);
      expect(() => providerServiceProfile(launch, undefined, personal)).toThrow(/isolated_absolute_userdata/);
      expect(() => providerServiceProfile(launch, 'relative', personal)).toThrow(/isolated_absolute_userdata/);
      expect(() => providerServiceProfile(launch, path.join(root, 'missing'), personal)).toThrow(/profile_must_exist/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts a first-use machine with no ordinary CoS profile and never creates one', () => {
    const { root, isolated } = create();
    const missingPersonal = path.join(root, 'fresh-normal', 'not-created');
    try {
      const launch = ['app.exe', PROVIDER_SERVICE_SWITCH];
      expect(providerServiceProfile(launch, isolated, missingPersonal)).toBe(prospectiveRealPath(isolated));
      expect(existsSync(missingPersonal)).toBeFalse();
      expect(() => providerServiceProfile(launch, root, missingPersonal)).toThrow(/profile_overlaps_personal_userdata/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses personal profile, its descendants and ancestors, including aliases', () => {
    const { root, personal, isolated } = create();
    const launch = ['app.exe', PROVIDER_SERVICE_SWITCH];
    const inside = path.join(personal, 'owned');
    mkdirSync(inside);
    try {
      for (const candidate of [personal, inside, root]) {
        expect(() => providerServiceProfile(launch, candidate, personal)).toThrow(/profile_overlaps_personal_userdata/);
      }
      const alias = path.join(root, 'personal-alias');
      try {
        symlinkSync(personal, alias, process.platform === 'win32' ? 'junction' : 'dir');
        expect(() => providerServiceProfile(launch, alias, personal)).toThrow(/profile_overlaps_personal_userdata/);
      } catch (error) {
        if (!(error instanceof Error) || !/EPERM|EACCES/.test(error.message)) throw error;
      }
      expect(providerServiceProfile(launch, isolated, personal)).toBe(isolated);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses startup without opt-in actions and built-in browser', () => {
    const ready = (browser: string, enabled: boolean, allowActions: boolean) =>
      providerServiceReady({ ui: { chatBrowser: browser }, controlApi: { enabled, allowActions } });
    expect(ready('cos', true, true)).toBeTrue();
    expect(ready('chrome', true, true)).toBeFalse();
    expect(ready('cos', true, false)).toBeFalse();
    expect(ready('cos', false, true)).toBeFalse();
  });
});
