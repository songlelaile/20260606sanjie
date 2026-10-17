#!/usr/bin/env node
'use strict';

// Actual local UI and account storage. Model submissions are denied throughout.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('/Users/shaozhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { createDemoServer } = require('./studio-main-demo.cjs');
const output = path.resolve(__dirname, '../docs/uat-api-wallet-switch-20261011');
const demo = createDemoServer({ port: 18849 });
const checks = [];
let browser;
function check(name, value) { assert.ok(value, name); checks.push(name); }
async function main() {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => demo.server.listen(18849, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => { window.__SANJIE_ENVIRONMENT = 'wallet-switch-local-uat'; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== demo.origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
    if (url.pathname === '/api/creative/proxy' || url.pathname === '/api/creative/native-video' && route.request().method() !== 'GET')
      throw new Error('Model submission attempted during UI verification');
    if (url.pathname === '/api/creative/native-video') return route.fulfill({ json: { configured: true, models: [{
      id: 'seedance-2.0', durations: [5, 10, 15], resolutions: ['720p', '1080p'], ratios: ['9:16', '16:9', '1:1'],
      generateAudio: false, reservationCents: 1000
    }], limits: { bodyBytes: 25165824 } } });
    return route.continue();
  });
  const imageUrl = `${demo.origin}/creative/labs/image-prompt-lab/promptlab.html?source=web&studio=1&mode=main`;
  await page.goto(imageUrl);
  await page.waitForFunction(() => window.SZ_CREATIVE_TOOLS_BRIDGE && window.state.archiveAccountKey !== 'local');
  await page.evaluate(async () => {
    const cfg = window.normalizeCfg({ provider: 'openai-compatible', apiKey: 'SYNTHETIC_SAVED_KEY',
      visionBaseUrl: 'https://custom.example/v1', imageEndpoint: 'https://custom.example/v1/images/generations' });
    const key = 'sz_image_prompt_lab_config_profiles_v2', owner = window.state.archiveAccountKey;
    await chrome.storage.local.set({ [key]: { accounts: { [owner]: { activeProvider: cfg.provider, configs: { [cfg.provider]: cfg } } } } });
    window.applyCfg(cfg);
    window.openConfigModal();
  });
  await page.locator('#usePlatformWalletBtn').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'image-desktop.png') });
  await page.locator('#usePlatformWalletBtn').click();
  await page.locator('#configModal').waitFor({ state: 'hidden' });
  check('Image button switches the live form without a user key', await page.evaluate(() =>
    window.SZ_CREATIVE_TOOLS_BRIDGE.modelInfo().supplyChannel === 'platform_wallet' && document.getElementById('apiKey').value === ''));
  await page.reload();
  await page.waitForFunction(() => window.SZ_CREATIVE_TOOLS_BRIDGE && window.state.archiveAccountKey !== 'local');
  check('Image wallet selection survives reload and retains the original same-provider API', await page.evaluate(async () => {
    const key = 'sz_image_prompt_lab_config_profiles_v2', stored = await chrome.storage.local.get(key);
    const account = stored[key].accounts[window.state.archiveAccountKey];
    return window.SZ_CREATIVE_TOOLS_BRIDGE.modelInfo().supplyChannel === 'platform_wallet' &&
      account.activeSupplyChannel === 'platform_wallet' && account.configs['openai-compatible'].apiKey === 'SYNTHETIC_SAVED_KEY';
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.openConfigModal());
  await page.screenshot({ path: path.join(output, 'image-mobile.png') });
  check('Image wallet button fits a mobile viewport', await page.locator('#usePlatformWalletBtn').evaluate(node => {
    const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
  }));
  await page.locator('[data-provider-pick="openai-compatible"]').click();
  await page.waitForFunction(() => document.getElementById('apiKey').value === 'SYNTHETIC_SAVED_KEY');
  check('Custom provider restores the saved API', await page.evaluate(async () => {
    const result = await window.SZ_CREATIVE_TOOLS_BRIDGE.getAccountKey();
    const key = 'sz_image_prompt_lab_config_profiles_v2', stored = await chrome.storage.local.get(key);
    return stored[key].accounts[result].activeSupplyChannel === 'external_key';
  }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${demo.origin}/creative/labs/ecommerce-video-studio/video-studio.html`);
  await page.waitForFunction(() => window.SanjieVideoSettingsBridge && window.SanjieVideoSettingsBridge.ready());
  await page.evaluate(async () => { await chrome.storage.local.set({ sz_web_video_api_key_v1: { 'demo-local:visitor': 'SYNTHETIC_VIDEO_KEY' } }); });
  await page.evaluate(() => { window.SanjieVideoSettingsBridge.openConfig(); });
  await page.locator('#sz-web-video-key-dialog').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'video-desktop.png') });
  await page.locator('#sz-web-video-key-dialog button[value="platform_wallet"]').click();
  await page.waitForFunction(() => !document.getElementById('open-api-settings').disabled);
  check('Video button preserves its saved API and selects native credits', await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('sz_web_video_api_key_v1');
    const result = await window.resolveUnifiedConfigReference({});
    return stored.sz_web_video_api_key_v1['demo-local:visitor'] === 'SYNTHETIC_VIDEO_KEY' && result.config.platformVideo && result.config.apiKey === '';
  }));
  await page.reload();
  await page.waitForFunction(() => window.SanjieVideoSettingsBridge && window.SanjieVideoSettingsBridge.ready());
  check('Video wallet selection survives reload', await page.evaluate(async () => (await window.resolveUnifiedConfigReference({})).config.platformVideo === true));
  await page.evaluate(() => { window.SanjieVideoSettingsBridge.openConfig(); });
  await page.locator('#sz-web-video-key-dialog input').fill('');
  await page.locator('#sz-web-video-key-dialog button[value="cancel"]').click();
  await page.locator('#sz-web-video-key-dialog').waitFor({ state: 'detached' });
  check('Video empty-key cancel leaves the wallet preference unchanged', await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('sz_web_video_billing_mode_v1');
    return stored.sz_web_video_billing_mode_v1['demo-local:visitor'] === 'platform_wallet';
  }));
  check('No browser runtime errors', errors.length === 0);
  check('No provider or paid requests', demo.metrics.blockedProxyRequests === 0 && demo.metrics.outboundProviderRequests === 0);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ scope: 'Actual local public UI, isolated fixture account; no deployment or paid calls', checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  demo.server.close();
});
