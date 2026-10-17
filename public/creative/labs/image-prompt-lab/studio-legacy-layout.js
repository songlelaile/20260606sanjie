/* Presentation only: retain the legacy form nodes, listeners, and route gates. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('layout') !== '1' || params.get('studio') === '1') return;
  const mode = params.get('mode');
  const surface = mode === 'sku' ? 'sku' : mode === 'viral' ? 'viral'
    : mode === 'detail' && params.get('detailMode') === 'reference' ? 'reference'
    : mode === 'main' && params.get('source') === 'web' ? 'main' : '';
  if (!surface) return;

  const paths = {
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 3 4-6 4 5"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
    scan: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M7 8h10M7 12h10M7 16h6"/>',
    history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
    book: '<path d="M12 7v14M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>'
  };
  const steps = {
    main: ['输入清单', '生成提示词', '确认设置', '生成中', '查看结果'],
    reference: ['输入', '分析结构', '确认规划', '批量生成', '查看结果'],
    sku: ['输入', '检查任务', '确认设置', '生成中', '查看结果'],
    viral: ['输入', '分析', '确认规划', '生成中', '查看结果']
  };
  const decorate = (element, name) => {
    if (!element) return;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.image}</svg>`;
    element.setAttribute('data-sl-icon', name);
    element.style.setProperty('--sl-icon', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
  };

  function start() {
    const app = document.querySelector('.app');
    const hero = app && app.querySelector('.hero');
    if (!app || !hero || document.getElementById('studioLegacySteps')) return;
    document.documentElement.classList.add('studio-legacy-layout');
    app.classList.add('sl-workspace', `sl-${surface}`);
    hero.classList.add('sl-hero');
    const progress = document.createElement('ol');
    progress.id = 'studioLegacySteps';
    progress.className = 'sl-steps';
    progress.setAttribute('aria-label', '创作步骤');
    // Only the new decorative progress element receives markup. No form is rebuilt.
    progress.innerHTML = steps[surface].map((label, index) => `<li${index ? '' : ' class="is-active"'}><b>${index + 1}</b><div><small>STEP 0${index + 1}</small><span>${label}</span></div></li>`).join('');
    hero.after(progress);
    decorate(document.getElementById('labHeroEyebrow'), surface === 'reference' ? 'scan' : surface === 'sku' ? 'layers' : surface === 'main' ? 'image' : 'spark');

    const icons = {
      openArchiveBtn: 'history', openKnowledgeBtn: 'book', loadSampleBtn: 'spark', openConfigBtn: 'settings',
      referenceSourceTitle: 'image', detailSubjectTitle: 'image', detailPromptStepTitle: 'spark',
      referenceDetailWorkbenchTitle: 'scan', referenceDetailBatchTitle: 'layers',
      referenceDetailBatchResultsTitle: 'image', generationTitle: 'settings', resultsTitle: 'image',
      archivePanelTitle: 'history', referenceDetailBuildBtn: 'spark', referenceDetailApproveBtn: 'check',
      analyzeBtn: 'scan', buildPromptBtn: 'spark', batchLinksBtn: 'layers',
      loadStoredLinksBtn: 'upload', linkTableTemplateBtn: 'download', copyAllPromptBtn: 'copy',
      linkNumberGenerateBtn: 'layers', mainStitchBtn: 'layers',
      referenceDetailBatchAddTargetBtn: 'plus', referenceDetailBatchStartBtn: 'spark',
      detailRefGenerateBtn: 'spark', generateBtn: 'spark', skuGenerateBtn: 'spark',
      downloadAllBtn: 'download', skuDownloadAllBtn: 'download', copyDetailPromptBtn: 'copy'
    };
    Object.entries(icons).forEach(([id, name]) => decorate(document.getElementById(id), name));
    if (surface === 'main') {
      const promptPanel = document.getElementById('cnPrompt')?.closest('.panel');
      if (promptPanel) promptPanel.classList.add('sl-main-prompts');
    }
    app.querySelectorAll('.sku-step-head > div > strong').forEach((heading, index) => decorate(heading, ['image', 'layers', 'settings', 'image'][index]));
    app.querySelectorAll('.detail-empty-icon').forEach(element => {
      // This element is decorative only; the actual inputs and result hosts stay intact.
      element.setAttribute('aria-hidden', 'true');
      decorate(element, 'spark');
      element.classList.add('sl-empty-icon');
    });

    // Show which part is being edited without asserting provider progress or completion.
    app.addEventListener('focusin', event => {
      const target = event.target;
      if (!target || !target.closest) return;
      let index = 0;
      if (surface === 'main') {
        if (target.closest('.results-shell, #resultGrid')) index = 4;
        else if (target.closest('.generation-actions')) index = 3;
        else if (target.closest('#generationPanel')) index = 2;
        else if (target.closest('.link-prompt-actions, .sl-main-prompts, #promptErrorPanel, #analyzeBtn')) index = 1;
      } else if (target.closest('.sku-result-step, #referenceDetailBatchResults, .results-shell, #resultGrid')) index = 4;
      else if (target.closest('.sku-generate-step, #generationPanel, #referenceDetailBatchPanel')) index = 3;
      else if (target.closest('#detailPromptStep, .reference-detail-editor-column')) index = 2;
      else if (target.closest('#referenceDetailModuleList, #skuTaskList')) index = 1;
      progress.querySelectorAll('li').forEach((item, number) => item.classList.toggle('is-active', number === index));
    });
    if (typeof window !== 'undefined' && window.SZ_LAB_STARTUP) window.SZ_LAB_STARTUP.ready();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
