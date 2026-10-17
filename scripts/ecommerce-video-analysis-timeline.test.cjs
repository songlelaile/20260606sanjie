'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const B = require('../public/creative/src/ecommerce-video-background.js');

function storyboard(seconds) {
  return Array.from({ length: seconds / 5 }, (_, index) => ({
    id: 'scene-' + (index + 1), order: index + 1, startSecond: index * 5,
    endSecond: (index + 1) * 5, durationSeconds: 5,
    visual: '人物沿同一方向连续前行，第 ' + (index + 1) + ' 个动作阶段。',
    motion: '从上一动作阶段继续，不重复起步。', narration: '确认台词第' + (index + 1) + '句。'
  }));
}

function harness(responseSeconds) {
  const calls = [], stored = {};
  const api = B.createController({
    resolveAccountKey: async () => 'offline-timeline-account',
    resolveCredentials: async () => ({ accountKey: 'offline-timeline-account', config: {
      apiKey: 'offline-analysis-credential', baseURL: 'https://analysis.fixture.test/v1', textModel: 'fixture-script-writer'
    } }),
    storageGet: async key => ({ [key]: structuredClone(stored[key]) }),
    storageSet: async update => Object.assign(stored, structuredClone(update)),
    fetch: async (url, options) => {
      assert.equal(url, 'https://analysis.fixture.test/v1/chat/completions');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body); calls.push(body);
      // Local fixture only: no request ever leaves this process.
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        creativeSummary: '连续动作与重新配音。', script: '完整画面脚本与“确认台词”。', storyboard: storyboard(responseSeconds)
      }) } }] });
    }
  });
  return { api, calls, stored };
}

function analyze(total) {
  return { type: B.MESSAGE_TYPES.ANALYZE, requestId: 'offline-analysis', request: {
    mode: 'assist', creativeRoute: 'storyboard_direct', productKey: 'seedance-2.0',
    goal: '按确认脚本生成连续走动，声音由台词重新配音。', durationSeconds: 15,
    ...(total ? { productionTimelineSeconds: total } : {}),
    resolution: '480p', ratio: '9:16', audioMode: 'narration', narrationLanguage: 'zh-CN',
    images: [], videos: [], audios: []
  } };
}

for (const seconds of [30, 60]) test(seconds + '-second production analysis prompts and validates the full storyboard', async () => {
  const h = harness(seconds);
  const result = await h.api.handleMessage(analyze(seconds));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.calls.length, 1);
  const prompt = h.calls[0].messages[1].content[0].text;
  assert.ok(prompt.includes('输出可编辑的 ' + seconds + ' 秒分镜脚本'));
  assert.ok(prompt.includes('storyboard 编辑时间轴之和必须等于 ' + seconds));
  assert.ok(prompt.includes('需要口播'));
  assert.ok(prompt.includes('上传音频仅作参考'));
  assert.equal(prompt.includes('全程无声，脚本不得包含口播'), false);
  const output = result.payload.analysis.storyboard;
  assert.equal(output.length, seconds / 5);
  assert.equal(output[0].startSecond, 0);
  assert.equal(output.at(-1).endSecond, seconds);
  assert.equal(output.reduce((sum, scene) => sum + scene.durationSeconds, 0), seconds);
  assert.equal(output.every(scene => scene.narration), true);
  assert.equal(h.stored[B.TASK_KEY], undefined, 'analysis cannot create a provider video task');
});

test('a shortened provider response is rejected against the full production timeline', async () => {
  const h = harness(15);
  const result = await h.api.handleMessage(analyze(60));
  assert.equal(result.ok, false);
  assert.equal(result.payload.error.code, 'ANALYSIS_SCHEMA_INVALID');
  assert.equal(result.payload.error.details.causeCode, 'STORYBOARD_TOTAL_DURATION_INVALID');
  assert.equal(h.calls.length, 1);
  assert.equal(h.stored[B.TASK_KEY], undefined);
});

test('legacy analysis without a production duration still uses the selected 15-second timeline', async () => {
  const h = harness(15);
  const result = await h.api.handleMessage(analyze());
  assert.equal(result.ok, true);
  assert.ok(h.calls[0].messages[1].content[0].text.includes('输出可编辑的 15 秒分镜脚本'));
  assert.equal(result.payload.analysis.storyboard.at(-1).endSecond, 15);
});

test('a long analysis timeline cannot bypass a provider submission duration limit', async () => {
  const h = harness(60);
  const request = analyze(60).request;
  const result = await h.api.handleMessage({ type: B.MESSAGE_TYPES.START, idempotencyKey: 'offline-never-submit',
    request: { ...request, mode: 'direct', creativeRoute: 'free_direct', script: 'A character walks continuously.',
      audioMode: 'silent', narrationLanguage: '', durationSeconds: 60 } });
  assert.equal(result.ok, false);
  assert.equal(result.payload.error.code, 'DURATION_INVALID');
  assert.equal(h.calls.length, 0);
  assert.equal(h.stored[B.TASK_KEY], undefined);
});
