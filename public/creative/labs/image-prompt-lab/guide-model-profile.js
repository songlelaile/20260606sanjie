(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_GUIDE_MODEL_PROFILE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'GUIDE_MODEL_PROFILE_V1';

  function modelFamily(model) {
    var value = String(model || '').trim().toLowerCase();
    if (!value) return 'unspecified';
    // Match the published name or its dated snapshot, never a decimal prefix.
    // Gateway aliases are recognized only for strategy selection; the request
    // retains the exact configured model ID.
    if (/^gpt-image-2\.5-sunburst(?:-\d{4}-\d{2}-\d{2})?$/.test(value) ||
        /^image-?2\.5-sunburst$/.test(value)) return 'gpt-image-2.5-sunburst';
    if (/^gpt-image-2(?:-\d{4}-\d{2}-\d{2})?$/.test(value) || /^image-?2$/.test(value)) return 'gpt-image-2';
    if (/^gpt-image-1\.5(?:-\d{4}-\d{2}-\d{2})?$/.test(value)) return 'gpt-image-1.5';
    if (/^gpt-image-1-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(value)) return 'gpt-image-1-mini';
    if (/^gpt-image-1(?:-\d{4}-\d{2}-\d{2})?$/.test(value)) return 'gpt-image-1';
    if (/^dall-e-2$/.test(value)) return 'dall-e-2';
    if (/^dall-e-3$/.test(value)) return 'text-to-image-only';
    if (/cogview|(?:^|[-_])(?:t2i|text-to-image)(?:$|[-_])/.test(value)) return 'text-to-image-only';
    if (/^(?:gemini-[a-z0-9.]+-(?:flash(?:-lite)?|pro)-image|nano-banana)/.test(value)) return 'gemini-image';
    if (/seedream/.test(value)) return 'seedream';
    if (/^wan[\d.]*-image(?:-edit)?(?:$|-)/.test(value)) return 'wan-image';
    if (/^qwen-image-edit(?:$|-)/.test(value)) return 'qwen-image-edit';
    if (/^(?:qwen-image|glm-image)(?:$|-)/.test(value)) return 'text-to-image-only';
    if (/^(?:gpt-(?:[3456](?:[.\w-]*)?|oss(?:[-\w]*)?)|o[134](?:$|[-.])|chatgpt-|claude-|deepseek-|qwen|glm-|gemini-)/.test(value)) return 'text-only';
    return 'unknown';
  }

  function resolve(cfg) {
    cfg = cfg || {};
    var model = String(cfg.imageModel || '').trim();
    var adapter = String(cfg.imageAdapter || '').trim();
    var family = modelFamily(model);
    var endpointKind = 'adapter-defined';
    if (adapter === 'openai-images') {
      var endpoint = String(cfg.imageEndpoint || '').trim();
      endpointKind = endpoint && !/^https?:\/\//i.test(endpoint) ? 'incompatible' :
        !endpoint || /\/images\/(?:generations|edits)\/?(?:\?.*)?$/i.test(endpoint) ? 'images-api' :
        /\/(?:chat\/completions|responses|videos)(?:\/|\?|$)/i.test(endpoint) ? 'incompatible' : 'custom-images';
    }
    var unsupported = family === 'text-only' || family === 'text-to-image-only';
    unsupported = unsupported || endpointKind === 'incompatible';
    var capability = 'unsupported';
    if (!unsupported) {
      if (adapter === 'openai-images') capability = /^(?:gpt-image-|dall-e-2$)/.test(family) || family === 'unknown' || family === 'unspecified'
        ? 'mask-guided' : 'annotation-reference';
      else if (adapter === 'generic-json') capability = 'client-composited-mask';
      else if (['dashscope-wan', 'doubao-image', 'volcengine-image', 'gemini-image', 'nano-banana'].indexOf(adapter) >= 0) capability = 'annotation-reference';
    }
    var style = family === 'gpt-image-2.5-sunburst' ? 'edit-first' : 'structured-edit';
    var strategy = style === 'edit-first' ? 'sunburst-precise-edit-v1' :
      family === 'gpt-image-2' ? 'image2-structured-edit-v1' : 'compatible-structured-edit-v1';
    var strategyLabel = style === 'edit-first' ? 'Sunburst 精准编辑：修改 / 保留 / 证据' :
      family === 'gpt-image-2' ? 'Image-2 结构化修复' : '兼容模型结构化修复';
    var labels = {
      'mask-guided': '原生遮罩编辑，保留局部修复边界',
      'client-composited-mask': '网关图片编辑，结果按遮罩合成保留原图',
      'annotation-reference': '标注参考编辑，遮罩外像素不保证不变',
      unsupported: '当前模型或适配器不支持引导重生'
    };
    var label = labels[capability];
    if (capability !== 'unsupported') {
      if (family === 'unknown' || family === 'unspecified') label = capability === 'mask-guided'
        ? '按图片编辑接口兼容发送遮罩，模型编辑能力未验证'
        : '兼容路径，模型编辑能力未验证；' + label;
      else if (style === 'edit-first') label = 'Sunburst 编辑优先；' + label;
    }
    return {
      version: VERSION,
      model: model,
      adapter: adapter,
      family: family,
      endpointKind: endpointKind,
      capability: capability,
      promptStyle: style,
      strategy: strategy,
      strategyLabel: strategyLabel,
      label: label,
      inputFidelity: adapter === 'openai-images' && (family === 'gpt-image-1' || family === 'gpt-image-1.5')
    };
  }

  function sameBinding(profile, cfg) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || profile.version !== VERSION) return false;
    var expected = resolve(cfg);
    return (!profile.endpointKind || profile.endpointKind === expected.endpointKind) && ['model', 'adapter', 'family', 'capability'].every(function (key) {
      return typeof profile[key] === 'string' && profile[key] === expected[key];
    });
  }

  // A separate edit prompt, deliberately independent of the old generation
  // layers and their internal screen/path/sequence instructions.
  function sunburstPrompt(contract) {
    contract = contract || {};
    var lines = [
      'CURRENT IMAGE EDIT — CHANGE / PRESERVE / EVIDENCE:',
      'Edit input image 1, the current selected result. Return one edited image with the same canvas, framing and aspect ratio.'
    ];
    var change = String(contract.guide || contract.issueLabel || '').trim();
    if (contract.operation === 'delete-visible-text') {
      change = 'Delete only the exact visible text “' + contract.textTarget + '” inside the editable region, including its own outline and shadow. ' +
        (contract.removeTextContainer ? 'Remove its selected backing plate only within that region.' : 'Keep its backing plate and label container; reconstruct only the revealed background naturally.');
    } else if (contract.operation === 'replace-visible-text') {
      change = 'Replace only the exact visible text “' + contract.textTarget + '” with “' + contract.replacementText + '” inside the editable region. Render the new text character-exact, legible, with the original typography and placement; do not retain the old selected text.';
    } else if (contract.exactCopy) {
      change += '\nUse the exact requested visible copy “' + contract.exactCopy + '”; do not paraphrase or translate it.';
    }
    lines.push('CHANGE: ' + change);
    if (contract.mode === 'subject') {
      lines.push(contract.subjectIntent === 'concept'
        ? 'This is the explicitly requested concept redesign, not a verified real-product photograph.'
        : contract.subjectIntent === 'polish'
          ? 'Improve only the selected product presentation; keep its actual structure, SKU color, material, quantity and function.'
          : 'Correct the selected product defect to match the uploaded current-SKU evidence. Preserve every verified feature; invent no invisible parts or new view.');
    }
    var preserve = (Array.isArray(contract.preserve) ? contract.preserve : []).filter(Boolean).join('；');
    lines.push('PRESERVE: Except for the explicit change, keep all other content unchanged' + (preserve ? ', including ' + preserve : '') + '.');
    if (contract.operation === 'delete-visible-text' || contract.operation === 'replace-visible-text') {
      lines.push('Keep every unselected visible character exactly, with its original font, size, color, spacing and position. The current image is the only visual source for this text edit.');
    } else {
      lines.push('EVIDENCE: Product photos after image 1 prove product identity, structure, color, material, logos and packaging only. Explicit person references prove the requested person identity only. Never use these evidence photos as a new canvas or import their backgrounds or unrelated text.');
    }
    var annotation = contract.annotation || {};
    if (annotation.hasEditMask && contract.adapterCapability !== 'annotation-reference') {
      lines.push('REGION: Transparent pixels in the attached PNG mask are editable; opaque pixels are protected. Limit the change to the editable region.');
    } else if (annotation.hasAnnotationImage) {
      lines.push('REGION: The marked reference locates the edit: red means must change and yellow means may harmonize. Keep unmarked content unchanged.');
    }
    if (contract.postCompositeOutsideMask) lines.push('Pixels outside the editable mask are restored from the original image after editing; make the repair meet the original boundary naturally.');
    var forbid = (Array.isArray(contract.forbid) ? contract.forbid : []).filter(Boolean).join('；');
    if (forbid) lines.push('Do not add or retain: ' + forbid + '.');
    lines.push('Apply this edit only to the selected image. Do not redesign the advertisement, enhance the whole image, or render region marks or editing instructions.');
    return lines.join('\n');
  }

  return { VERSION: VERSION, resolve: resolve, sameBinding: sameBinding, sunburstPrompt: sunburstPrompt };
});
