import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prospectiveRealPath, providerServiceProfile, PROVIDER_SERVICE_SWITCH } from '../src/main/provider-service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('provider first-use profile identity', () => {
  it('does not create a missing ordinary CoS profile or confuse it with the isolated provider', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'coo-first-use-'));
    roots.push(root);
    const isolated = path.join(root, 'isolated');
    const personal = path.join(root, 'uncreated', 'personal');
    mkdirSync(isolated);
    expect(existsSync(personal)).toBe(false);
    expect(providerServiceProfile(['app.exe', PROVIDER_SERVICE_SWITCH], isolated, personal))
      .toBe(prospectiveRealPath(isolated));
    expect(existsSync(personal)).toBe(false);
    expect(() => providerServiceProfile(['app.exe', PROVIDER_SERVICE_SWITCH], root, personal))
      .toThrow(/profile_overlaps_personal_userdata/);
  });

  it('canonicalizes a non-existent personal path beneath an existing alias', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'coo-first-use-alias-'));
    roots.push(root);
    const physical = path.join(root, 'physical');
    const isolated = path.join(physical, 'provider');
    mkdirSync(physical);
    mkdirSync(isolated);
    const alias = path.join(root, 'alias');
    try { symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) return;
      throw error;
    }
    const personal = path.join(alias, 'not-created');
    expect(prospectiveRealPath(personal)).toBe(path.join(prospectiveRealPath(physical), 'not-created'));
    expect(() => providerServiceProfile(['app.exe', PROVIDER_SERVICE_SWITCH], isolated, physical))
      .toThrow(/profile_overlaps_personal_userdata/);
    expect(existsSync(personal)).toBe(false);
  });
});
