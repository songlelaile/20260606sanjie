/* Exercise the actual ACK helper with isolated storage and lock fault injection. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'public/creative/labs/image-prompt-lab/promptlab.js'), 'utf8');
const start = source.indexOf('function acknowledgeSkuDelivery(');
const end = source.indexOf('\nfunction send(type, payload)', start);
assert.ok(start >= 0 && end > start, 'the current product ACK helper must be present');
const helper = source.slice(start, end);
function harness(options = {}) {
  const state = { archiveAccountKey: 'alice', stopRequested: false };
  const key = 'sz.legacy-image-receipt.v1:alice:fixture', bobKey = 'sz.legacy-image-receipt.v1:bob:fixture';
  const delivery = { version: 1, state: 'delivered', jobId: 'alice-job', images: ['data:image/jpeg;base64,returned'] };
  const deliveries = new Map([['alice', delivery], ['bob', { jobId: 'bob-job', images: ['bob-image'] }]]);
  const markers = new Map([[key, JSON.stringify({ version: 1, state: 'delivered', storage: 'indexeddb', jobId: 'alice-job' })],
    [bobKey, JSON.stringify({ version: 1, state: 'delivered', jobId: 'bob-job' })]]);
  const calls = [];
  let enterLock;
  const context = vm.createContext({ state, Promise,
    fetch() { throw new Error('ACK tests cannot call a provider.'); },
    localStorage: {
      getItem(name) { return markers.get(name) ?? null; },
      removeItem(name) {
        if (options.markerThrows) throw new Error('localStorage unavailable');
        if (!options.markerSilent) markers.delete(name);
      }
    },
    navigator: { locks: { request(name, lockOptions, callback) {
      calls.push(['lock', name, lockOptions.mode]);
      if (options.queueLock) return new Promise(resolve => { enterLock = () => Promise.resolve(callback()).then(resolve); });
      return Promise.resolve(callback());
    } } },
    SZ_SKU_DELIVERY_STORE: {
      async read(owner, receiptKey) { calls.push(['read', owner, receiptKey]); return deliveries.get(owner) ?? null; },
      async remove(owner, receiptKey, jobId) {
        calls.push(['remove', owner, receiptKey, jobId]);
        if (options.changeOwnerDuringRemove) state.archiveAccountKey = 'bob';
        const current = deliveries.get(owner);
        if (!current) return { ok: true, removed: false, reason: 'missing' };
        if (current.jobId !== jobId) return { ok: true, removed: false, reason: 'job_mismatch' };
        deliveries.delete(owner); return { ok: true, removed: true };
      },
      async save(owner, receiptKey, backup) {
        calls.push(['save', owner, receiptKey, backup.jobId]);
        assert.equal(deliveries.has(owner), false, 'compensation must restore an absent delivery');
        deliveries.set(owner, backup); return { ok: true };
      }
    }
  });
  vm.runInContext(helper, context, { filename: 'product acknowledgeSkuDelivery' });
  return { state, key, delivery, deliveries, markers, calls,
    run: () => context.acknowledgeSkuDelivery({ _skuReceipt: { key, jobId: 'alice-job', owner: 'alice' } }),
    enterLock: () => enterLock(),
    assertBobUnchanged() { assert.equal(deliveries.get('bob').jobId, 'bob-job'); assert.equal(JSON.parse(markers.get(bobKey)).jobId, 'bob-job'); }
  };
}
test('owner switch while ACK waits for the lock retains both original records', async () => {
  const h = harness({ queueLock: true }), ack = h.run();
  h.state.archiveAccountKey = 'bob'; h.enterLock();
  assert.equal(await ack, false); assert.equal(h.deliveries.get('alice'), h.delivery); assert.ok(h.markers.has(h.key));
  assert.equal(h.calls.some(call => call[0] === 'remove'), false); h.assertBobUnchanged();
});
test('owner switch during IDB deletion completes ACK for the captured original owner', async () => {
  const h = harness({ changeOwnerDuringRemove: true });
  assert.equal(await h.run(), true); assert.equal(h.state.archiveAccountKey, 'bob');
  assert.equal(h.deliveries.has('alice'), false); assert.equal(h.markers.has(h.key), false); h.assertBobUnchanged();
});
test('localStorage throw after IDB deletion restores the delivered bytes', async () => {
  const h = harness({ markerThrows: true });
  assert.equal(await h.run(), false); assert.equal(h.deliveries.get('alice'), h.delivery); assert.ok(h.markers.has(h.key));
  assert.ok(h.calls.some(call => call[0] === 'save' && call[1] === 'alice' && call[3] === 'alice-job')); h.assertBobUnchanged();
});
test('silent localStorage deletion failure also restores the delivered bytes', async () => {
  const h = harness({ markerSilent: true });
  assert.equal(await h.run(), false); assert.equal(h.deliveries.get('alice'), h.delivery); assert.ok(h.markers.has(h.key)); h.assertBobUnchanged();
});
test('a newer marker job blocks ACK before it touches delivered bytes', async () => {
  const h = harness(); h.markers.set(h.key, JSON.stringify({ jobId: 'newer-job' }));
  assert.equal(await h.run(), false); assert.equal(h.deliveries.get('alice'), h.delivery);
  assert.equal(JSON.parse(h.markers.get(h.key)).jobId, 'newer-job'); assert.equal(h.calls.some(call => call[0] === 'remove'), false); h.assertBobUnchanged();
});
test('IDB compare-and-remove does not remove a newer delivery job', async () => {
  const h = harness(); h.deliveries.set('alice', { jobId: 'newer-job', images: ['newer-image'] });
  assert.equal(await h.run(), false); assert.equal(h.deliveries.get('alice').jobId, 'newer-job'); assert.ok(h.markers.has(h.key)); h.assertBobUnchanged();
});
test('ordinary archive-committed ACK clears the matching owner and job records', async () => {
  const h = harness(); assert.equal(await h.run(), true);
  assert.equal(h.deliveries.has('alice'), false); assert.equal(h.markers.has(h.key), false); h.assertBobUnchanged();
});
