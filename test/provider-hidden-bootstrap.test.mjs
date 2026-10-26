import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapProviderBrowserTab, PROVIDER_SERVICE_SWITCH, PROVIDER_SIGN_IN_SWITCH } from '../src/main/provider-service.ts';

function browser() {
  const tabs = [];
  const calls = [];
  return {
    calls, tabs,
    async start() { calls.push('start'); },
    control: { model: { query({ url }) {
      assert.equal(url, 'https://chatgpt.com/*');
      return tabs.filter(tab => tab.url.startsWith('https://chatgpt.com/'));
    } } },
    async open(url, options) {
      calls.push({ url, options });
      tabs.push({ url });
    },
  };
}

test('hidden provider opens exactly one unshown ChatGPT page after browser startup', async () => {
  const instance = browser();
  assert.equal(await bootstrapProviderBrowserTab(['provider.exe', PROVIDER_SERVICE_SWITCH], instance), true);
  assert.deepEqual(instance.calls, ['start', { url: 'https://chatgpt.com/', options: { reveal: false } }]);
  assert.equal(await bootstrapProviderBrowserTab(['provider.exe', PROVIDER_SERVICE_SWITCH], instance), false);
  assert.deepEqual(instance.calls, ['start', { url: 'https://chatgpt.com/', options: { reveal: false } }, 'start']);
});

test('normal and explicitly visible sign-in modes never create an offscreen page', async () => {
  for (const flags of [[], [PROVIDER_SIGN_IN_SWITCH], [PROVIDER_SERVICE_SWITCH, PROVIDER_SIGN_IN_SWITCH]]) {
    const instance = browser();
    assert.equal(await bootstrapProviderBrowserTab(['provider.exe', ...flags], instance), false);
    assert.deepEqual(instance.calls, []);
  }
});

test('existing provider ChatGPT page is reused and a failed startup cannot open a page', async () => {
  const instance = browser();
  instance.tabs.push({ url: 'https://chatgpt.com/c/previous' });
  assert.equal(await bootstrapProviderBrowserTab(['provider.exe', PROVIDER_SERVICE_SWITCH], instance), false);
  assert.deepEqual(instance.calls, ['start']);
  instance.start = async () => { throw new Error('extension_not_loaded'); };
  await assert.rejects(bootstrapProviderBrowserTab(['provider.exe', PROVIDER_SERVICE_SWITCH], instance), /extension_not_loaded/);
  assert.equal(instance.tabs.length, 1);
});
