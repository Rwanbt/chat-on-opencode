import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerServiceProfile, providerServiceReady, PROVIDER_SERVICE_SWITCH } from '../src/main/provider-service.js';

describe('standalone provider service admission', () => {
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
