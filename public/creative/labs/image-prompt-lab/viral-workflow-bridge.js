/* Same-origin navigation guard for the three dedicated viral workflow frames. */
(function (root) {
  'use strict';
  var params = new URLSearchParams(root.location.search);
  var routes = ['case', 'style-refresh', 'scene-extension'];
  if (params.get('workflow') !== '1' || params.get('mode') !== 'viral' || params.get('source') !== 'web' || params.get('layout') !== '1' || params.get('studio') === '1' || routes.indexOf(params.get('creativeRoute')) < 0) return;
  if (root.SanjieViralWorkflowBridge) return;

  var sends = 0, uploads = 0, activation = null;
  function wrap(target, name, category) {
    if (!target || typeof target[name] !== 'function') return;
    var original = target[name];
    target[name] = function () {
      if (category === 'send') sends++; else uploads++;
      var result;
      function finish() { if (category === 'send') sends--; else uploads--; }
      try { result = original.apply(this, arguments); }
      catch (error) { finish(); throw error; }
      return Promise.resolve(result).then(function (value) { finish(); return value; }, function (error) { finish(); throw error; });
    };
  }
  // Classic-script global bindings read the wrapped function too. Controllers
  // which captured a sender earlier are covered by their full workflow state.
  wrap(root, 'send', 'send');
  wrap(root, 'fileToOptimizedDataUrl', 'upload');
  if (root.SZ_IMAGE_UPLOAD) wrap(root.SZ_IMAGE_UPLOAD, 'retainOriginal', 'upload');

  function blocked(reason) { return { allowed: false, reason: reason }; }
  function status(ignoreActivation) {
    var state = root.state || {};
    if (!ignoreActivation && activation) return blocked('正在刷新当前账号配置，请稍候。');
    if (sends) return blocked('当前工作台还有请求未完成，请等待完成或先停止任务。');
    if (uploads || root.SZ_IMAGE_UPLOAD && typeof root.SZ_IMAGE_UPLOAD.isImporting === 'function' && root.SZ_IMAGE_UPLOAD.isImporting()) return blocked('素材正在读取或导入，请等待完成后切换。');
    if (state.activeJobId || state.activeJobIds && Object.keys(state.activeJobIds).length) return blocked('图片任务正在运行，请等待完成或先停止。');
    var run = state.styleRefresh && state.styleRefresh.run;
    if (run && ['generating', 'qa', 'qa-retry'].indexOf(run.phase) >= 0) return blocked('风格焕新正在生成或检查，请等待完成或先停止。');
    var scene = root.SZ_SCENE_EXTENSION_CONTROLLER && root.SZ_SCENE_EXTENSION_CONTROLLER.state;
    if (scene && scene.busy) return blocked('场景延展正在生成，请等待完成或先停止。');
    if (scene && (Number(scene.uploadReading) > 0 || scene.importReading)) return blocked('场景素材正在读取或导入，请等待完成后切换。');
    return { allowed: true, reason: '' };
  }
  function canDeactivate() {
    try { return status(false); }
    catch (_) { return blocked('暂时无法确认任务状态，请稍候重试。'); }
  }
  function owner() {
    var key = root.state && root.state.archiveAccountKey;
    return typeof key === 'string' && key && key !== 'local' ? key : '';
  }
  function activate() {
    if (activation) return activation;
    var idle = canDeactivate();
    if (!idle.allowed) return Promise.resolve({ ok: false, code: 'WORKFLOW_BUSY', error: idle.reason });
    var capturedOwner = owner();
    if (!capturedOwner || typeof root.send !== 'function' || typeof root.applyCfg !== 'function') return Promise.resolve({ ok: false, code: 'WORKFLOW_NOT_READY', error: '账号配置尚未就绪，请等待加载完成。' });
    activation = Promise.resolve().then(function () {
      // Refresh only saved API fields. No imports, planning, generation, history
      // writes or route changes are performed when a cached frame is activated.
      return root.send('GET_CONFIG_PROFILE', { provider: '' });
    }).then(function (profile) {
      if (!profile || !profile.ok || profile.accountKey !== capturedOwner || owner() !== capturedOwner || !profile.config || typeof profile.config !== 'object' || Array.isArray(profile.config)) {
        return { ok: false, code: 'WORKFLOW_ACCOUNT_CHANGED', error: profile && profile.error || '登录账号已变化，请刷新工作台后继续；原账号草稿仍保留。' };
      }
      var stillIdle = status(true);
      if (!stillIdle.allowed) return { ok: false, code: 'WORKFLOW_BUSY', error: stillIdle.reason };
      root.applyCfg(profile.config);
      return { ok: true, accountKey: capturedOwner };
    }).catch(function (error) {
      return { ok: false, code: 'WORKFLOW_REFRESH_FAILED', error: error && error.message || String(error) };
    }).finally(function () { activation = null; });
    return activation;
  }
  root.SanjieViralWorkflowBridge = Object.freeze({ canDeactivate: canDeactivate, activate: activate });
})(typeof globalThis !== 'undefined' ? globalThis : window);
