/* Paste only into the dedicated nonce-bearing new production tab. No test flags or model stubs. */
(async () => {
  const C = __REFERENCE_AUTH_CONFIG_JSON__;
  const url = new URL(location.href);
  if (window !== window.top || location.origin !== C.origin || url.pathname !== C.pathname || url.searchParams.get('sz_ref_acceptance') !== C.runSuffix) throw new Error('Use the dedicated acceptance new tab');
  if (window.__SZ_PROMPTLAB_TEST_MODE__ || window.__SZ_PROMPTLAB_BACKGROUND_TEST_MODE__) throw new Error('Actual acceptance must use real production runtime');
  if (window.__szRefAuthUat?.config?.runSuffix === C.runSuffix) {
    if (window.__szRefAuthUat.harnessVersion !== 3) throw new Error('Older acceptance harness is pending; reload only this dedicated nonce tab before installing V3');
    return { alreadyInstalled: true, ready: !!window.__szRefAuthUat.ready, stages: window.__szRefAuthUat.stages.length, initialization: window.__szRefAuthUat.initialization };
  }
  const U = { config: C, harnessVersion: 3, startedAt: new Date().toISOString(), startPerformance: performance.now(), messages: [], blocked: [], stages: [], assets: [], initialization: { state: 'checking', timeoutMs: 25000 } };
  window.__szRefAuthUat = U;
  const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const hashText = text => digest(new TextEncoder().encode(text));
  const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' timed out; refuse intake without bypassing the real account or business guards')), ms);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  const initializationDeadline = performance.now() + U.initialization.timeoutMs;
  const initializeWithinDeadline = (promise, label) => withTimeout(promise, Math.max(1, initializationDeadline - performance.now()), label);
  // The sealed runtime's configAccountKeyFromAuth is bundled/private. Encode
  // the real authCheck result locally with its exact rule; export no new globals.
  const accountKeyFromRealAuth = auth => {
    const user = auth && auth.ok && auth.user ? auth.user : null;
    const raw = user && (user.id || user.userId || user.uid || user.email || user.username || user.name || user.mobile || user.phone);
    return raw ? 'user:' + String(raw).replace(/[^\w@.+:-]/g, '_').slice(0, 120) : 'local';
  };
  const assertIdentity = async () => {
    const S = window.state, ownerBefore = S?.archiveAccountKey, epochBefore = S?.archiveIdentityVersion;
    if (!S?.referenceDetail || !S?.referenceDetailBatch || typeof ownerBefore !== 'string' || !ownerBefore.startsWith('user:') || !Number.isSafeInteger(epochBefore) || epochBefore < 1) throw new Error('Native authenticated owner/archive epoch is not initialized');
    if (typeof window.authCheck !== 'function' || typeof window.SZ_CREATIVE_TOOLS_BRIDGE?.getAccountKey !== 'function') throw new Error('Real production account readers are missing');
    const [owner, auth] = await withTimeout(Promise.all([window.SZ_CREATIVE_TOOLS_BRIDGE.getAccountKey(), window.authCheck()]), 18000, 'Fresh authenticated owner reads');
    if (!auth?.ok || typeof auth.user?.id !== 'string' || !auth.user.id || accountKeyFromRealAuth(auth) !== owner || owner !== ownerBefore || S !== window.state || S.archiveAccountKey !== ownerBefore || S.archiveIdentityVersion !== epochBefore || window !== window.top || location.origin !== C.origin || new URL(location.href).searchParams.get('sz_ref_acceptance') !== C.runSuffix) throw new Error('Actual login/account/archive epoch changed; refuse intake');
    if (C.expectedOwnerAccountKey && owner !== C.expectedOwnerAccountKey) throw new Error('Dedicated acceptance tab is authenticated to a different owner');
    if (U.initializationGate && (owner !== U.initializationGate.ownerAccountKey || epochBefore !== U.initializationGate.archiveIdentityVersion || auth.user.id !== U.initializationGate.backendAuthUserId)) throw new Error('Acceptance owner/archive epoch changed after initialization');
    return { owner, auth, epoch: epochBefore };
  };
  const dangerousType = /(?:GENERATE|CREATE_(?:IMAGE|VIDEO)|ANALYZE|BUILD_REFERENCE_DETAIL|APPROVE|SAVE_CONFIG|SET_ACTIVE_PROVIDER|USE_PLATFORM_WALLET|SAVE_REFERENCE_DETAIL|REGISTER_REFERENCE_DETAIL_BATCH|CANCEL|DELETE|REMOVE)/i;
  const dangerousUrl = value => /\/api\/creative\/(?:proxy|billing\/(?:quote|cancel|commit|reserve)|video|image\/generate)|\/(?:images\/(?:generations|edits)|chat\/completions|contents\/generations)/i.test(String(value));
  const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = function (message, callback) {
    const type = String(message?.type || ''); U.messages.push({ type, at: new Date().toISOString() });
    if (dangerousType.test(type)) {
      U.blocked.push({ kind: 'message', type }); const result = { ok: false, code: 'UAT_READ_ONLY', providerSubmitted: false, error: 'Acceptance blocks paid and saved-state mutations' };
      if (typeof callback === 'function') queueMicrotask(() => callback(result)); return Promise.resolve(result);
    }
    return originalSend(message, callback);
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, options) {
    const target = typeof input === 'string' ? input : input?.url || String(input);
    if (dangerousUrl(target)) { U.blocked.push({ kind: 'fetch', path: new URL(target, location.href).pathname }); return Promise.reject(new Error('Acceptance blocks provider/billing dispatch')); }
    return originalFetch(input, options);
  };
  const denyIds = new Set(['referenceDetailBuildBtn','referenceDetailRebuildBtn','referenceDetailApproveBtn','referenceDetailSaveBlueprintBtn','referenceDetailSaveRevisionBtn','referenceDetailVerifyTrustBtn','referenceDetailLoadBlueprintBtn','referenceDetailBatchStartBtn','referenceDetailBatchResumeBtn','referenceDetailBatchRetryFailedBtn','referenceDetailBatchStopAllBtn','generateBtn','batchBtn','analyzeBtn','buildPromptBtn','detailRefGenerateBtn','linkNumberGenerateBtn','skuGenerateBtn','saveConfigBtn','usePlatformWalletBtn']);
  document.addEventListener('click', event => { const button = event.target.closest?.('button'); if (button && denyIds.has(button.id)) { event.preventDefault(); event.stopImmediatePropagation(); U.blocked.push({ kind: 'button', id: button.id }); } }, true);
  U.getReferenceDetailInputBusyReason = () => {
    if (typeof window.referenceDetailConfirmationMutationAllowed !== 'function' || typeof window.referenceDetailBatchUiBusy !== 'function') throw new Error('Actual intake guards are missing');
    return (window.referenceDetailConfirmationMutationAllowed() ? 0 : 1) | (window.referenceDetailBatchUiBusy() ? 2 : 0);
  };
  const originals = async () => {
    const rows = [];
    for (const info of (await indexedDB.databases()).filter(info => /^sz_image_upload_originals_v1(?:$|:)/.test(info.name))) {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open(info.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      if (db.objectStoreNames.contains('originals')) {
        const items = await new Promise((resolve, reject) => { const request = db.transaction('originals', 'readonly').objectStore('originals').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        for (const item of items) rows.push({ database: info.name, id: item.id, accountKey: item.accountKey, hash: item.hash, actualHash: await digest(await item.blob.arrayBuffer()), bytes: item.bytes });
      }
      db.close();
    }
    return rows;
  };
  const storage = async () => {
    const result = {};
    for (const [label, area] of [['local', localStorage], ['session', sessionStorage]]) for (let index = 0; index < area.length; index++) {
      const key = area.key(index); if (/(?:config|profile|draft|blueprint|batch|runtime|context|history|archive|receipt|pending|queue)/i.test(key)) result[label + ':' + key] = await hashText(area.getItem(key) || '');
    }
    return result;
  };
  U.capture = async label => {
    const { owner, auth, epoch } = await assertIdentity();
    const S = window.state, source = S.referenceDetail.source;
    const refs = S.refImages || [];
    const sourceImages = source ? [...source.orderedBlocks].sort((a, b) => a.originalIndex - b.originalIndex).map(block => source.assets.find(asset => asset.assetId === block.assetIds[0])?.url || '') : [];
    const stage = { label, capturedAt: new Date().toISOString(), ownerAccountKey: owner, backendAuthUserId: auth.user.id, archiveIdentityVersion: epoch,
      inputBusyReason: U.getReferenceDetailInputBusyReason(), sourceSchema: source?.schema || null, sourceDigest: S.referenceDetail.sourceDigest,
      sourcePlatform: source?.source?.platform || '', sourceItemId: source?.source?.itemId || '', sourceFactsCount: source?.facts?.length || 0,
      referenceOnly: !!source && source.assets.every(asset => asset.rightsStatus === 'reference_only'),
      refs: await Promise.all(refs.map(hashText)), sourceRefs: await Promise.all(sourceImages.map(hashText)),
      previewRefs: await Promise.all([...document.querySelectorAll('#refPreview img')].map(image => hashText(image.src))),
      analyzeEnabled: !document.getElementById('referenceDetailBuildBtn').disabled,
      sourceInputVisible: !document.getElementById('referenceSourcePanel').hidden && document.getElementById('referenceSourcePanel').getAttribute('aria-hidden') !== 'true',
      mainActiveJobId: S.activeJobId || '', currentReferenceJobs: Object.keys(S.referenceDetailBatch.activeJobs || {}),
      currentReferenceTasks: Object.keys(S.referenceDetailBatch.activeTasks || {}), originals: await originals(), protectedStorage: await storage() };
    if (S !== window.state || S.archiveAccountKey !== owner || S.archiveIdentityVersion !== epoch) throw new Error('Native owner/archive epoch changed while reading preservation evidence');
    U.stages.push(stage); return { label, referenceCount: stage.refs.length, originalCount: stage.originals.length, busyReason: stage.inputBusyReason, sourceSchema: stage.sourceSchema };
  };
  try {
  // DETAIL initializes through loadContext/sceneReady. The creative-only ready
  // promise is unrelated to screenshot intake and never resolves on this route.
  const panel = document.getElementById('referenceSourcePanel'), fileInput = document.getElementById('refFile');
  if (document.readyState === 'loading' || !panel || panel.hidden || panel.getAttribute('aria-hidden') === 'true' || !panel.getClientRects().length || !fileInput || fileInput.disabled || typeof window.importReferenceDetailScreenshots !== 'function' || typeof window.SZ_REFERENCE_DETAIL_CONTRACT?.createScreenshotSource !== 'function' || typeof window.SZ_IMAGE_UPLOAD?.retainOriginal !== 'function') throw new Error('Actual screenshot input/source/original-preservation capabilities are not initialized');
  const identity = await initializeWithinDeadline(assertIdentity(), 'Authenticated screenshot initialization');
  const busyReason = U.getReferenceDetailInputBusyReason();
  if (busyReason) throw new Error('Current reference confirmation/batch is busy; do not bypass it');
  U.initializationGate = { kind: 'actual_auth_owner_archive_epoch_and_screenshot_intake', ownerAccountKey: identity.owner, backendAuthUserId: identity.auth.user.id, backendAuthUsername: identity.auth.user.username || null, backendAuthRole: identity.auth.user.role || null, authIdentityEncoding: 'sealed_configAccountKeyFromAuth_encoding', bundledConfigHelperRequired: false, archiveIdentityVersion: identity.epoch, inputBusyReason: busyReason, screenshotInputVisible: true, sourceConstructorAvailable: true, originalPreservationAvailable: true, creativeOnlyReadyAwaited: false };
  for (const asset of C.assets) {
    const response = await initializeWithinDeadline(fetch(asset.path + '?sz_ref_read=' + encodeURIComponent(C.runSuffix), { credentials: 'same-origin', cache: 'no-store' }), 'Readonly asset fetch ' + asset.path);
    if (!response.ok) throw new Error('Readonly asset fingerprint failed: ' + asset.path);
    U.assets.push({ path: asset.path, expectedSha256: asset.sha256, actualSha256: await initializeWithinDeadline(response.arrayBuffer().then(digest), 'Readonly asset digest ' + asset.path) });
  }
  if (U.assets.some(asset => asset.actualSha256 !== asset.expectedSha256)) throw new Error('Production six files/dependencies differ from the sealed candidate');
  U.loadedScripts = [...document.scripts].filter(script => script.src).map(script => new URL(script.src).pathname);
  U.loadedStyles = [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => new URL(link.href).pathname);
  U.export = async () => {
    await U.capture('final'); const before = U.stages[0], after = U.stages.at(-1);
    const missingOriginals = before.originals.filter(item => !after.originals.some(next => next.database === item.database && next.id === item.id));
    const changedOriginals = before.originals.filter(item => { const next = after.originals.find(next => next.database === item.database && next.id === item.id); return next && (next.actualHash !== item.actualHash || next.accountKey !== item.accountKey || next.bytes !== item.bytes); });
    const changedProtectedStorage = Object.entries(before.protectedStorage).filter(([key, hash]) => after.protectedStorage[key] !== hash).map(([key]) => key);
    const dangerousNetwork = performance.getEntriesByType('resource').filter(entry => entry.startTime >= U.startPerformance && dangerousUrl(entry.name)).map(entry => ({ path: new URL(entry.name).pathname, initiatorType: entry.initiatorType }));
    const result = { schema: 'SZ_REFERENCE_DETAIL_AUTHENTICATED_UI_ACCEPTANCE_V1', runSuffix: C.runSuffix, targetUrl: location.href, startedAt: U.startedAt, finishedAt: new Date().toISOString(), mockUsed: false,
      harnessVersion: U.harnessVersion, initialization: U.initialization, initializationGate: U.initializationGate, expectedManifestSha256: C.manifestSha256, assets: U.assets, loadedScripts: U.loadedScripts, loadedStyles: U.loadedStyles, stages: U.stages, messages: U.messages, blocked: U.blocked,
      preservation: { beforeOriginalCount: before.originals.length, afterOriginalCount: after.originals.length, missingOriginals, changedOriginals, changedProtectedStorage }, dangerousNetwork,
      paidAnalysisPerformed: false, imageGenerationPerformed: false, evidenceLayer: 'authenticated_source_intake_and_original_preservation_only' };
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })); link.download = C.runSuffix + '.json'; link.click();
    return { filename: link.download, stages: result.stages.length, preservedOriginals: !missingOriginals.length && !changedOriginals.length, protectedStorageChanges: changedProtectedStorage.length, blocked: U.blocked.length, dangerousNetwork: dangerousNetwork.length };
  };
  const before = await initializeWithinDeadline(U.capture('before'), 'Original/storage baseline capture');
  if (before.referenceCount !== 0) throw new Error('Dedicated new route is not empty; preserve the inherited references and inspect before proceeding');
  U.ready = true;
  U.initialization.state = 'ready';
  return { ready: true, harnessVersion: U.harnessVersion, runSuffix: C.runSuffix, originalCount: before.originalCount, inputBusyReason: before.busyReason, assetsMatched: U.assets.length, initializationGate: U.initializationGate };
  } catch (error) {
    U.ready = false; U.initialization.state = 'refused'; U.initialization.error = error.message || String(error); throw error;
  }
})();
