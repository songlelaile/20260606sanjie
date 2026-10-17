(() => {
  'use strict';
  const apiBase = '/sower-work/app/api/sower/cloud-workbench';
  const $ = id => document.getElementById(id);
  const node = (tag, value, className) => { const element = document.createElement(tag); if (value != null) element.textContent = value; if (className) element.className = className; return element; };
  let active, status;
  const messages = { NOT_FOUND: '当前账号没有这份记录。', REVISION_CONFLICT: '记录已经更新，请重新打开后再保存。', HUMAN_CONFIRMATION_REQUIRED: '请先人工确认词根。', ANNOTATION_COVERAGE_INCOMPLETE: '人工注释必须覆盖所有去重关键词。', ANNOTATION_ROOT_MAPPING_INVALID: '词根拼合必须覆盖原关键词，并且每根都需选择类型。', COMPLETE_MARKET_INPUT_REQUIRED: '请先导入完整同范围市场原表。', HUMAN_ANNOTATIONS_REQUIRED: '请先保存完整的人工拆词。', MARKET_SCOPE_MISMATCH: '市场文件的范围必须与当前词表完全一致；请参考当前范围模板。', MARKET_ALREADY_BOUND_IMPORT_NEW_JOB: '这份任务已保留市场原件。更换来源请新建任务。', FILE_SIZE_LIMIT: '每个文件最多 5 MB。', KEYWORD_FILE_TYPE_UNSUPPORTED: '关键词仅支持 CSV 或标准 sources JSON。', WORKSPACE_STORAGE_LIMIT: '当前工作区文件总量达到 128 MB 上限。', LINK_GENERATION_MAX_200_KEYWORDS: '一次规则评分最多 200 个词，请按同一范围分批导入。' };
  function message(value) { $('message').textContent = value; $('message').style.display = 'block'; }
  async function api(path, method = 'GET', data) {
    const response = await fetch(apiBase + path, { method, credentials: 'same-origin', headers: data ? { 'Content-Type': 'application/json' } : {}, ...(data ? { body: JSON.stringify(data) } : {}) });
    const result = await response.json();
    if (!response.ok || !result.success) { const code = result.error?.code || '请求失败'; let detail = result.error?.detail || ''; if (detail.includes('Missing popularity')) detail = '人气存在缺失或区间，不能进入旧引擎的评分阶段；已去重的词根清单仍可导出。'; throw new Error((messages[code] || code) + (detail ? '\n' + detail : '')); }
    return result.data;
  }
  async function run(call) { const buttons = [...document.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true); try { await call(); } catch (error) { message(error.message); } finally { buttons.forEach(button => button.disabled = false); } }
  async function content(file) { if (!file || !file.size || file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5 MB 的文件。'); const bytes = new Uint8Array(await file.arrayBuffer()); let string = ''; for (let i = 0; i < bytes.length; i += 4096) string += String.fromCharCode(...bytes.slice(i, i + 4096)); return { fileName: file.name, contentBase64: btoa(string) }; }
  function downloadLink(path, label, secondary = false) { const link = node('a', label, 'download' + (secondary ? ' secondary' : '')); link.href = apiBase + path; return link; }
  function localDownload(name, value) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  async function jobs() { const result = await api('/jobs'); $('jobs').replaceChildren(); result.jobs.forEach(job => { const button = node('button', job.fileName + ' · ' + job.stats.uniqueCount + '词', 'secondary'); button.onclick = () => run(async () => show(await api('/jobs/' + job.id))); $('jobs').append(button); }); return result.jobs; }
  function show(job) {
    active = job; $('active').classList.remove('hidden');
    $('stage').textContent = ({ 'awaiting-human-annotation': '等待人工拆词', 'human-annotated': '人工词根已确认', 'market-imported': '市场原件已绑定', 'draft-needs-review': '规则清单草稿 · 待复核' })[job.stage] || job.stage;
    $('stats').textContent = '原始 ' + job.merged.stats.inputCount + ' 词 → 去重后 ' + job.merged.stats.uniqueCount + ' 词，去掉 ' + job.merged.stats.removedCount + ' 个重复。缺失精确人气 ' + job.merged.words.filter(word => word.pop === null).length + ' 词。';
    $('scope').textContent = '范围：' + job.scope.platform + ' / ' + job.scope.categoryId + ' / ' + job.scope.startDate + ' 至 ' + job.scope.endDate + ' / 商品 ' + (job.scope.objectId || '未限定') + '。原件 SHA-256：' + job.originalSha256;
    $('downloads').replaceChildren(downloadLink('/jobs/' + job.id + '/original', '下载原件', true), downloadLink('/jobs/' + job.id + '/export?format=json', '完整 JSON', true), downloadLink('/jobs/' + job.id + '/export?format=csv', job.output ? '导出链接清单 CSV' : '导出词根清单 CSV'));
    if (job.market) $('downloads').append(downloadLink('/jobs/' + job.id + '/market-original', '市场原件', true));
    $('roots').replaceChildren();
    job.merged.words.slice(0, 200).forEach(word => {
      const saved = job.annotations?.find(value => value.kw === word.kw);
      const row = node('div', null, 'root-row'); row.dataset.keyword = word.kw;
      row.append(node('strong', word.kw), node('span', word.pop === null ? '人气缺失' : String(word.pop), 'muted'));
      const input = node('input'); input.setAttribute('aria-label', word.kw + '的词根'); input.placeholder = '词根1|词根2'; input.value = saved?.parts.join('|') || '';
      const types = node('div', null, 'types');
      const renderTypes = previous => { types.replaceChildren(); input.value.split('|').map(value => value.trim()).filter(Boolean).forEach((root, index) => { const select = node('select'); select.setAttribute('aria-label', root + '的类型'); select.append(new Option(root + '：选择类型', '')); status.demandTypes.forEach(type => select.append(new Option(type, type))); select.value = previous?.[index] || ''; types.append(select); }); };
      renderTypes(saved?.partTypes); input.oninput = () => renderTypes([...types.querySelectorAll('select')].map(select => select.value));
      row.append(input, types); $('roots').append(row);
    });
    if (job.merged.words.length > 200) $('roots').append(node('p', '仅展示前 200 词。请导入覆盖全部关键词的人工注释 JSON，或按原范围分批处理。', 'muted'));
    $('market-state').textContent = job.market ? '已绑定：' + job.market.fileName + '，' + job.market.rows.length + ' 行；完整性由导入者声明，未采集真实平台。SHA-256：' + job.market.originalSha256 : '尚未绑定市场原件。';
    $('output').replaceChildren();
    if (job.output) {
      $('output').append(node('p', '生成 ' + job.output.generated.links + ' 条规则草稿；系统没有调用模型、平台或付费任务。商品事实、标题与营销文案需要复核。'));
      if (job.output.generated.titleFailures?.length) $('output').append(node('p', '有 ' + job.output.generated.titleFailures.length + ' 条标题未满足原引擎规则；请补充证据并复核，不能直接上架。', 'muted'));
      const sheet = job.output.generated.sheets[0]; const wrap = node('div', null, 'table-wrap'); const table = node('table'); const head = node('tr'); sheet.headers.forEach(value => head.append(node('th', value))); table.append(head); sheet.rows.slice(0, 20).forEach(values => { const row = node('tr'); values.forEach(value => row.append(node('td', value))); table.append(row); }); wrap.append(table); $('output').append(wrap);
    }
  }
  async function saveAnnotations(annotations) { show(await api('/jobs/' + active.id + '/annotations', 'PUT', { expectedRevision: active.revision, humanConfirmed: true, annotations })); await jobs(); message('人工拆词已保存，原件仍保留。'); }
  $('import-form').onsubmit = event => { event.preventDefault(); run(async () => { const source = await content($('keyword-file').files[0]); const job = await api('/jobs', 'POST', { ...source, sourceKind: $('kind').value, scope: { platform: $('platform').value.trim(), categoryId: $('category').value.trim(), startDate: $('start').value, endDate: $('end').value, objectId: $('object').value.trim() || null } }); show(job); await jobs(); message('原件已保存，去重完成。下一步请人工拆词。'); }); };
  $('save-roots').onclick = () => run(async () => { if (!active) return; const annotations = [...$('roots').querySelectorAll('.root-row')].map(row => ({ kw: row.dataset.keyword, parts: row.querySelector('input').value.split('|').map(value => value.trim()).filter(Boolean), partTypes: [...row.querySelectorAll('select')].map(select => select.value) })); await saveAnnotations(annotations); });
  $('annotation-file').onchange = () => run(async () => { if (!active) return; const file = $('annotation-file').files[0]; if (!file || file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5 MB 的人工注释 JSON。'); const value = JSON.parse(await file.text()); await saveAnnotations(value.annotations || value); });
  $('market-template').onclick = () => { if (active) localDownload('同范围市场原表模板.json', { scope: active.scope, kind: 'sycm-market-rank', complete: false, scopeVerified: false, rows: [] }); };
  $('market-form').onsubmit = event => { event.preventDefault(); run(async () => { if (!active) return; show(await api('/jobs/' + active.id + '/market', 'PUT', { ...await content($('market-file').files[0]), expectedRevision: active.revision, scopeVerified: $('scope-confirmed').checked, complete: $('complete-confirmed').checked })); await jobs(); message('市场原件已绑定，来源和 SHA-256 已保存。'); }); };
  $('generate').onclick = () => run(async () => { if (!active) return; show(await api('/jobs/' + active.id + '/generate', 'POST', { expectedRevision: active.revision, category: active.scope.categoryId, limit: Number($('limit').value) })); await jobs(); message('规则清单草稿已生成，可导出完整 JSON 和 CSV。'); });
  async function knowledge() { const result = await api('/knowledge'); $('knowledge').replaceChildren(); result.files.forEach(file => { const row = node('div', null, 'knowledge-row'); row.append(node('span', file.fileName + ' · ' + (file.status === 'pending' ? '待解析' : file.statusCode === 'image_no_ocr' ? '原图已保存 · 未OCR' : '可检索正文 ' + file.textChars + '字')), downloadLink('/knowledge/' + file.id + '/original', '原件', true)); $('knowledge').append(row); }); }
  $('knowledge-form').onsubmit = event => { event.preventDefault(); run(async () => { await api('/knowledge', 'POST', await content($('knowledge-file').files[0])); await knowledge(); message('知识原件已保存。'); }); };
  $('search-form').onsubmit = event => { event.preventDefault(); run(async () => { const result = await api('/knowledge/search?q=' + encodeURIComponent($('query').value.trim())); $('search-result').replaceChildren(); if (!result.hits.length) $('search-result').append(node('p', '当前账号的已解析文本与文件名中没有匹配结果。', 'muted')); result.hits.forEach(hit => { const panel = node('div', null, 'snippet'); panel.append(node('strong', hit.fileName), node('p', hit.snippet)); $('search-result').append(panel); }); }); };
  run(async () => { status = await api('/status'); $('account').textContent = status.userName + ' · 独立云端工作区'; const existing = await jobs(); await knowledge(); if (existing[0]) show(await api('/jobs/' + existing[0].id)); window.__sowerCloudNotifyReady?.(); });
})();
