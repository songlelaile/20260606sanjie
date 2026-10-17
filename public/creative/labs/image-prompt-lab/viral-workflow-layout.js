/* Presentation only. Dedicated routes retain their original controls and gates. */
(() => {
  'use strict';
  const routes = {
    case: ['referenceSourcePanel', 'detailPromptStep', 'generationPanel'],
    'style-refresh': ['detailSubjectStep', 'styleRefreshPanel', 'generationPanel'],
    'scene-extension': ['sceneMaterialPanel', 'sceneConfigPanel', 'sceneResultsPanel']
  };
  const icons = {
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 3 4-6 4 5"/>'
  };

  function start() {
    const body = document.body;
    const route = body && body.getAttribute('data-viral-workflow');
    if (!body || !body.classList.contains('viral-dedicated-workspace') || !Object.hasOwn(routes, route)) return;
    const app = document.querySelector('.app');
    const hero = app && app.querySelector('.hero');
    if (!app || !hero || document.getElementById('viralWorkflowSteps')) return;
    app.classList.add('vw-workspace');
    if (route === 'style-refresh') {
      const style = document.getElementById('styleRefreshPanel');
      const plan = document.getElementById('detailPromptStep');
      // Legacy markup/runtime ordering differs across releases. Reorder only
      // the whole sibling section, preserving every control and its parents.
      if (style && plan && style.parentNode === app && plan.parentNode === app) app.insertBefore(style, plan);
    }

    const progress = document.createElement('ol');
    progress.id = 'viralWorkflowSteps';
    progress.className = 'vw-steps';
    progress.setAttribute('aria-label', '创作流程');
    ['上传素材', '创作设置 / 计划', '生成 / 结果'].forEach((label, index) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      const number = document.createElement('b');
      const text = document.createElement('span');
      const icon = ['upload', 'settings', 'image'][index];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[icon]}</svg>`;
      item.style.setProperty('--vw-icon', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
      link.setAttribute('href', '#' + routes[route][index]);
      number.textContent = '0' + (index + 1);
      text.textContent = label;
      link.appendChild(number); link.appendChild(text); item.appendChild(link); progress.appendChild(item);
    });
    hero.after(progress);

    const sections = route === 'scene-extension'
      ? { sceneMaterialPanel: '01 · 上传素材', sceneConfigPanel: '02 · 创作设置 / 计划', sceneResultsPanel: '03 · 生成 / 结果' }
      : { referenceSourcePanel: '01 · 上传素材', detailSubjectStep: '01 · 上传素材', styleRefreshPanel: '02 · 创作设置 / 计划', detailPromptStep: '02 · 创作设置 / 计划', generationPanel: '03 · 生成 / 结果' };
    Object.entries(sections).forEach(([id, label]) => {
      const section = document.getElementById(id);
      if (section) section.setAttribute('data-vw-stage', label);
    });

    // Only optional containers acquire a new parent. Their form controls keep
    // their original parents, IDs, listeners, values and fieldset ancestry.
    function fold(element, label) {
      if (!element || !element.parentNode || element.closest('.vw-optional')) return;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      details.className = 'vw-optional';
      summary.textContent = label;
      element.parentNode.insertBefore(details, element);
      details.appendChild(summary); details.appendChild(element);
      const sync = () => { details.hidden = element.hidden || element.getAttribute('aria-hidden') === 'true'; };
      sync();
      if (typeof MutationObserver === 'function') {
        new MutationObserver(sync).observe(element, { attributes: true, attributeFilter: ['hidden', 'aria-hidden'] });
      }
    }
    const byId = (id, label) => fold(document.getElementById(id), label);
    const one = (selector, label) => fold(app.querySelector(selector), label);
    function foldGroup(elements, label, kind, gridClass) {
      const originals = elements.filter(Boolean);
      const parent = originals[0] && originals[0].parentNode;
      if (!parent || originals.some(element => element.parentNode !== parent || element.closest('.vw-optional'))) return;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const content = document.createElement('div');
      details.className = 'vw-optional vw-extra-' + kind;
      summary.textContent = label;
      content.className = gridClass;
      parent.insertBefore(details, originals[0]);
      details.appendChild(summary); details.appendChild(content);
      originals.forEach(element => content.appendChild(element));
      const sync = () => { details.hidden = originals.every(element => element.hidden || element.getAttribute('aria-hidden') === 'true'); };
      sync();
      if (typeof MutationObserver === 'function') {
        const observer = new MutationObserver(sync);
        originals.forEach(element => observer.observe(element, { attributes: true, attributeFilter: ['hidden', 'aria-hidden'] }));
      }
    }
    if (route === 'scene-extension') {
      ['sceneMaterialPanel', 'sceneConfigPanel', 'sceneResultsPanel'].forEach(id => {
        const section = document.getElementById(id);
        fold(section && section.querySelector('.scene-heading > div > p'), '查看说明');
      });
      one('#sceneMaterialPanel > .scene-note', '图片要求');
      one('#sceneConfigPanel > .scene-note', '生成与保真说明');
      foldGroup(['sceneDetailPreview', 'sceneSectionPreview', 'sceneAnglePreview'].map(id => {
        const preview = document.getElementById(id);
        return preview && preview.closest('.scene-material-card');
      }), '补充角度（可选）', 'angles', 'vw-angle-grid');
      foldGroup(['sceneSku', 'sceneDimensions', 'sceneColorNotes', 'sceneTextureNotes', 'sceneFinishNotes', 'sceneDisplayNotes'].map(id => {
        const input = document.getElementById(id);
        return input && input.closest('label');
      }), '产品细节（可选）', 'fields', 'vw-field-grid');
    } else {
      byId('detailSubjectSubtitle', '素材要求');
      byId('detailPromptStepSubtitle', '计划说明');
      byId('detailGenerationRoute', '生成说明');
      one('#detailPromptStep > .detail-shell > .detail-config > .detail-text-grid', '补充商品信息（可选）');
      if (route === 'case') {
        byId('referenceSourceSubtitle', '参考图要求');
        byId('viralDerivativeBlueprint', '案例学习规则');
        byId('referenceLearningNote', '素材使用说明');
      } else {
        one('.style-refresh-operation-guide', '操作说明');
      }
    }

    // If validation or an existing handler focuses an optional field, make it
    // reachable without submitting, resetting or changing any business state.
    const reveal = event => {
      const target = event.target;
      const details = target && target.closest && target.closest('.vw-optional');
      if (details) details.open = true;
    };
    app.addEventListener('focusin', reveal);
    app.addEventListener('invalid', reveal, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
