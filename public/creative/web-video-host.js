/* 网站视频使用服务端供应；保留当前账号已有的外部视频配置。 */
(function (global) {
  "use strict";

  var KEY = "sz_web_video_api_key_v1";
  var MODE_KEY = "sz_web_video_billing_mode_v1";
  var ANALYSIS_PROFILES_KEY = "sz_image_prompt_lab_config_profiles_v2";

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function own(value, key) {
    return object(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  function analysisFailure(id, code, message) {
    return { ok: false, accountKey: id, code: code, error: message };
  }

  function platformAnalysisProfile(id, user, selected) {
    var base = "https://sub.shaozhuangai.com/v1";
    var cfg = { apiKey: "", provider: "openai-compatible", visionBaseUrl: base, visionModel: "chatGPT5.5" };
    if (object(selected) && selected.provider === "openai-compatible" &&
        !String(selected.apiKey || "").trim() && typeof selected.visionModel === "string" &&
        selected.visionModel.trim() && selected.visionModel.length <= 220 && !/[\u0000-\u001f\u007f]/.test(selected.visionModel)) {
      try {
        var chat = new URL(selected.visionBaseUrl);
        var image = new URL(selected.imageEndpoint);
        var canonical = [chat, image].every(function (url) {
          return url.protocol === "https:" && url.hostname === "sub.shaozhuangai.com" &&
            !url.username && !url.password && !url.port && !url.search && !url.hash;
        });
        if (canonical && /^\/v1\/?$/.test(chat.pathname) && /^\/v1\/images\/(?:generations|edits)\/?$/.test(image.pathname)) {
          cfg.visionBaseUrl = chat.href.replace(/\/+$/, "");
          cfg.visionModel = selected.visionModel.trim();
        }
      } catch (_) {}
    }
    if (!global.SZ_WEB_SUPPLY || typeof global.SZ_WEB_SUPPLY.usesServerCredentials !== "function" ||
        !global.SZ_WEB_SUPPLY.usesServerCredentials(cfg.visionBaseUrl + "/chat/completions")) {
      return analysisFailure(id, "ANALYZER_CONFIG_UNAVAILABLE", "平台脚本分析连接不可用，请刷新后重试。");
    }
    return { ok: true, user: user, config: cfg };
  }

  function readAnalysisProfiles() {
    return new Promise(function (resolve, reject) {
      try {
        global.chrome.storage.local.get([ANALYSIS_PROFILES_KEY], function (stored) {
          if (global.chrome.runtime.lastError) { reject(new Error("storage_read_failed")); return; }
          resolve(stored && stored[ANALYSIS_PROFILES_KEY]);
        });
      } catch (_) { reject(new Error("storage_read_failed")); }
    });
  }

  async function personalAnalysisProfile(id) {
    var store;
    try { store = await readAnalysisProfiles(); }
    catch (_) {
      return analysisFailure(id, "ANALYZER_PROFILE_READ_FAILED", "个人分析 API 配置读取失败，已停止本次请求，请刷新后重试。");
    }
    var latest = await global.authCheck();
    if (!latest || !latest.ok || accountId(latest) !== id) {
      return analysisFailure(id, "ACCOUNT_CHANGED", "读取分析 API 配置时登录账号已变化。");
    }
    if (store === undefined) return { ok: true, user: latest.user, config: null };
    if (!object(store) || !object(store.accounts)) {
      return analysisFailure(id, "ANALYZER_CONFIG_INVALID", "个人分析 API 配置无效，请在主图工作台重新保存配置。");
    }
    // Use the image profile's exact account-key rule, never activeAccount,
    // shared presets or an unowned legacy key. Video task identities stay raw.
    var profileKey = "user:" + String(id).replace(/[^\w@.+:-]/g, "_").slice(0, 120);
    if (!own(store.accounts, profileKey)) return { ok: true, user: latest.user, config: null };
    var account = store.accounts[profileKey];
    if (object(account) && account.activeSupplyChannel === "platform_wallet") {
      return platformAnalysisProfile(id, latest.user, account.platformWalletConfig);
    }
    if (!object(account) || !object(account.configs) ||
        (account.activeProvider != null && typeof account.activeProvider !== "string")) {
      return analysisFailure(id, "ANALYZER_CONFIG_INVALID", "当前账号的分析 API 配置无效，请重新保存。");
    }
    var provider = typeof account.activeProvider === "string" ? account.activeProvider.trim() : "";
    if (!provider && Object.keys(account.configs).length) {
      return analysisFailure(id, "ANALYZER_CONFIG_INVALID", "个人 API 服务商尚未确认，请在主图工作台选择并保存；本次不会使用平台积分。");
    }
    if (!provider) return { ok: true, user: latest.user, config: null };
    if (!own(account.configs, provider)) {
      return analysisFailure(id, "ANALYZER_CONFIG_INVALID", "选中的个人 API 配置已缺失，请在主图工作台重新选择并保存；本次不会使用平台积分。");
    }
    var cfg = account.configs[provider];
    if (!object(cfg) || (cfg.apiKey != null && typeof cfg.apiKey !== "string") ||
        (cfg.provider != null && cfg.provider !== provider)) {
      return analysisFailure(id, "ANALYZER_CONFIG_INVALID", "当前账号的分析 API 配置无效，请重新保存。");
    }
    var key = typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";
    if (!key) return { ok: true, user: latest.user, config: null };
    if (key.length > 1000 || /[\u0000-\u0020\u007f]/.test(key)) {
      return analysisFailure(id, "ANALYZER_CONFIG_INVALID", "个人分析 API Key 格式无效，请重新保存；本次不会使用平台积分。");
    }
    // The current analyzer sends OpenAI-compatible multimodal chat messages.
    // Gemini and text-only profiles must not silently become platform requests.
    if (["openai-compatible", "openai", "doubao", "zhipu", "dashscope", "shaozhuang"].indexOf(provider) < 0 ||
        cfg.imageAdapter === "nano-banana" || cfg.imageAdapter === "gemini-image") {
      return analysisFailure(id, "ANALYZER_API_UNSUPPORTED", "当前个人 API 不兼容此视觉分析，请选择支持 OpenAI 兼容视觉接口的配置；本次不会使用平台积分。");
    }
    var base = typeof cfg.visionBaseUrl === "string" ? cfg.visionBaseUrl.trim().replace(/\/+$/, "") : "";
    var model = typeof cfg.visionModel === "string" ? cfg.visionModel.trim() : "";
    if (!base || base.length > 2048 || !model || model.length > 220 || /[\u0000-\u001f\u007f]/.test(model)) {
      return analysisFailure(id, "ANALYZER_CONFIG_INVALID", "个人视觉分析端点或模型未配置，请在主图工作台保存；本次不会使用平台积分。");
    }
    try {
      var url = new URL(base);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
          url.hostname === "generativelanguage.googleapis.com") throw new Error("incompatible_endpoint");
      // The website's existing shaozhuang analysis profile is Sub2-compatible;
      // do not assume this legacy label declares other providers' capabilities.
      if (provider === "shaozhuang" && (url.origin !== "https://sub.shaozhuangai.com" ||
          !/^\/v1(?:\/chat\/completions)?$/.test(url.pathname))) {
        return analysisFailure(id, "ANALYZER_API_UNSUPPORTED", "该个人分析 API 的接口协议尚未确认，请选择 OpenAI 兼容视觉配置；本次不会使用平台积分。");
      }
    } catch (_) {
      return analysisFailure(id, "ANALYZER_CONFIG_INVALID", "个人视觉分析端点必须是无内嵌凭据的 HTTPS 兼容接口；本次不会使用平台积分。");
    }
    return { ok: true, user: latest.user, config: {
      apiKey: key, provider: provider, visionBaseUrl: base, visionModel: model
    } };
  }

  function readSettings() {
    return new Promise(function (resolve, reject) {
      global.chrome.storage.local.get([KEY, MODE_KEY], function (stored) {
        var error = global.chrome.runtime.lastError;
        if (error) { reject(new Error(error.message || "无法读取视频配置。")); return; }
        var keys = stored && stored[KEY];
        var modes = stored && stored[MODE_KEY];
        resolve({ keys: keys && typeof keys === "object" && !Array.isArray(keys) ? keys : {},
          modes: modes && typeof modes === "object" && !Array.isArray(modes) ? modes : {} });
      });
    });
  }

  function writeSettings(update) {
    return new Promise(function (resolve, reject) {
      global.chrome.storage.local.set(update, function () {
        var error = global.chrome.runtime.lastError;
        if (error) { reject(new Error(error.message || "无法保存视频配置。")); return; }
        resolve();
      });
    });
  }

  function accountId(auth) {
    var user = auth && auth.user;
    return user && (user.id || user.username) || "";
  }

  async function requireSameAccount(id) {
    var auth = await global.authCheck();
    if (!auth || !auth.ok || !accountId(auth) || accountId(auth) !== id) {
      throw Object.assign(new Error("登录账号已变化，请刷新工作台后重新配置。"), { code: "ACCOUNT_CHANGED" });
    }
    return auth;
  }

  global.resolveUnifiedConfigReference = async function (request) {
    var auth = typeof global.authCheck === "function" ? await global.authCheck() : { ok: false };
    var id = accountId(auth);
    var requested = request && (request.accountKey || request.accountId) || "";
    if (!auth || !auth.ok || !id) {
      return { ok: false, code: "ACCOUNT_UNAVAILABLE", error: "无法确定当前登录账号，已阻止跨账号读写。" };
    }
    if (requested && requested !== id) {
      return { ok: false, code: "ACCOUNT_CHANGED", error: "解析 API 配置时账号已变更。" };
    }
    if (request && request.purpose === "account") {
      return { ok: true, accountKey: id, user: auth.user, config: {} };
    }
    if (request && request.purpose === "analysis") {
      var analysisSettings;
      try { analysisSettings = await readSettings(); }
      catch (_) { return analysisFailure(id, "ANALYZER_PROFILE_READ_FAILED", "分析使用方式读取失败，请刷新后重试。"); }
      var analysisAuth = await global.authCheck();
      if (!analysisAuth || !analysisAuth.ok || accountId(analysisAuth) !== id) {
        return analysisFailure(id, "ACCOUNT_CHANGED", "读取分析使用方式时登录账号已变化。");
      }
      if (analysisSettings.modes[id] === "platform_wallet") {
        var walletAnalysis = platformAnalysisProfile(id, analysisAuth.user);
        return walletAnalysis.ok ? { ok: true, accountKey: id, user: walletAnalysis.user, config: walletAnalysis.config } : walletAnalysis;
      }
      var personal = await personalAnalysisProfile(id);
      if (!personal.ok) return personal;
      if (personal.config) return { ok: true, accountKey: id, user: personal.user, config: personal.config };
      var analysisBase = "https://sub.shaozhuangai.com/v1";
      if (!global.SZ_WEB_SUPPLY || typeof global.SZ_WEB_SUPPLY.usesServerCredentials !== "function" ||
          !global.SZ_WEB_SUPPLY.usesServerCredentials(analysisBase + "/chat/completions")) {
        return { ok: false, accountKey: id, code: "ANALYZER_CONFIG_UNAVAILABLE", error: "平台脚本分析连接不可用，请刷新后重试。" };
      }
      return { ok: true, accountKey: id, user: personal.user,
        config: { apiKey: "", provider: "shaozhuang", visionBaseUrl: analysisBase, visionModel: "chatGPT5.5" } };
    }
    var settings = await readSettings();
    var latest = await global.authCheck();
    if (!latest || !latest.ok || accountId(latest) !== id) {
      return { ok: false, accountKey: id, code: "ACCOUNT_CHANGED", error: "读取视频配置时登录账号已变化。" };
    }
    var apiKey = typeof settings.keys[id] === "string" ? settings.keys[id].trim() : "";
    if (apiKey && settings.modes[id] !== "platform_wallet") {
      return { ok: true, accountKey: id, user: latest.user,
        config: { apiKey: apiKey, provider: "doubao" } };
    }
    var platformReason = "平台视频供应尚未就绪，请联系管理员配置视频供应。";
    try {
      var response = await global.fetch("/api/creative/native-video", { method: "GET", credentials: "same-origin", cache: "no-store", headers: { "X-Sanjie-Expected-Account": id } });
      var platform = response.ok ? await response.json() : null;
      var checked = await global.authCheck();
      if (!checked || !checked.ok || accountId(checked) !== id) {
        return { ok: false, accountKey: id, code: "ACCOUNT_CHANGED", error: "读取视频供应时登录账号已变化，请重新核对方案。" };
      }
      if (platform && platform.reason && typeof platform.reason.message === "string") platformReason = platform.reason.message.slice(0, 500);
      if (platform && platform.configured === true && Array.isArray(platform.models) && platform.models.length) {
        var billingMode = platform.billingMode === "prepaid_quote" ? "prepaid_quote" : platform.billingMode === "direct_usage" ? "direct_usage" : "";
        var nativeModels = platform.models.filter(function (model) {
          return model && ["seedance-2.0-mini", "seedance-2.0", "seedance-2.5"].indexOf(model.id) >= 0 &&
            Array.isArray(model.durations) && model.durations.length &&
            Array.isArray(model.resolutions) && model.resolutions.length && Array.isArray(model.ratios) && model.ratios.length;
        }).map(function (model) {
          var modelBillingMode = model.billingMode === "prepaid_quote" ? "prepaid_quote" : model.billingMode === "direct_usage" ? "direct_usage" : billingMode;
          return { id: model.id, providerModel: model.id, durations: model.durations.slice(),
            resolutions: model.resolutions.slice(), ratios: model.ratios.slice(), generateAudio: model.generateAudio === true,
            billingMode: modelBillingMode,
            submissionQuotes: Array.isArray(model.submissionQuotes) ? model.submissionQuotes.slice() : [],
            reservationCents: ["prepaid_quote", "direct_usage"].indexOf(modelBillingMode) >= 0 ? 0 : Number.isSafeInteger(model.reservationCents) && model.reservationCents > 0 ? model.reservationCents : null,
            estimateCents: Number.isSafeInteger(model.estimateCents) && model.estimateCents > 0 ? model.estimateCents : null };
        });
        if (nativeModels.length) {
          return { ok: true, accountKey: id, user: checked.user, config: { apiKey: "", provider: "shaozhuang-native", platformVideo: true,
            billingMode: billingMode, platformModels: nativeModels, maxBodyBytes: Math.min(24 * 1024 * 1024, Number(platform.limits && platform.limits.bodyBytes) || 24 * 1024 * 1024) } };
        }
      }
    } catch (_) {
      // An old release may have no native endpoint; retain the user's existing
      // external configuration without treating an unavailable platform as ready.
    }
    // A missing provider key must not erase the verified signed-in identity.
    return { ok: false, code: "CREDENTIALS_UNAVAILABLE", error: platformReason, accountKey: id, user: latest.user };
  };

  function openDialog() {
    return global.authCheck().then(function (auth) {
      var id = accountId(auth);
      if (!auth || !auth.ok || !id) throw new Error("无法确定当前登录账号。");
      return readSettings().then(function (settings) {
        return requireSameAccount(id).then(function () {
          return { id: id, key: typeof settings.keys[id] === "string" ? settings.keys[id] : "" };
        });
      });
    }).then(function (owner) { return new Promise(function (resolve) {
      var existing = global.document.getElementById("sz-web-video-key-dialog");
      if (existing) existing.remove();
      var dialog = global.document.createElement("dialog");
      dialog.id = "sz-web-video-key-dialog";
      dialog.style.cssText = "border:1px solid #31411f;border-radius:16px;background:#10170b;color:#f4f7ea;padding:0;max-width:440px;width:calc(100% - 32px);";
      dialog.innerHTML = ''
        + '<form method="dialog" style="display:grid;gap:12px;padding:20px;">'
        + '<strong style="font-size:18px;">配置豆包 / 火山方舟</strong>'
        + '<p style="margin:0;color:#c9d3b4;line-height:1.5;">密钥只保存在这台浏览器的当前登录账号里，不会写入页面源码。网站只负责转发到火山方舟。</p>'
        + '<label style="display:grid;gap:6px;">API Key<input name="apiKey" type="password" autocomplete="off" required style="min-height:40px;border-radius:8px;border:1px solid #31411f;background:#0b1007;color:#fff;padding:0 10px;"></label>'
        + '<div style="display:grid;gap:6px;border:1px solid #31411f;border-radius:10px;padding:12px;">'
        + '<button value="platform_wallet" type="submit" formnovalidate style="min-height:40px;border-radius:8px;border:1px solid #d6f36b;background:transparent;color:#d6f36b;font-weight:700;padding:0 14px;">直接使用积分</button>'
        + '<span style="color:#c9d3b4;font-size:13px;">无需填写 API Key，使用本站积分</span></div>'
        + '<div style="display:flex;justify-content:flex-end;gap:8px;">'
        + '<button value="cancel" type="submit" formnovalidate style="min-height:36px;border-radius:8px;border:1px solid #31411f;background:transparent;color:#f4f7ea;padding:0 12px;">取消</button>'
        + '<button value="save" type="submit" style="min-height:36px;border-radius:8px;border:0;background:#d6f36b;color:#141b07;font-weight:700;padding:0 14px;">保存</button>'
        + '</div></form>';
      global.document.body.appendChild(dialog);
      var input = dialog.querySelector("input");
      if (input) input.value = owner.key;
      dialog.showModal();
      if (input) input.focus();
      dialog.addEventListener("close", function () {
        var saved = dialog.returnValue === "save";
        var wallet = dialog.returnValue === "platform_wallet";
        var value = input ? input.value.trim() : "";
        dialog.remove();
        resolve(wallet ? { id: owner.id, billingMode: "platform_wallet" }
          : saved ? { id: owner.id, billingMode: "api", value: value } : null);
      }, { once: true });
    }); });
  }

  global.chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.type !== "OPEN_UNIFIED_API_SETTINGS") return false;
    openDialog().then(function (draft) {
      if (!draft) {
        sendResponse({ ok: true, opened: true, saved: false, cancelled: true });
        return;
      }
      return requireSameAccount(draft.id).then(function () {
        if (draft.billingMode === "api" && !draft.value) throw new Error("请填写 API Key，或选择直接使用积分。");
        return readSettings().then(function (settings) {
          return requireSameAccount(draft.id).then(function () {
            var update = {};
            settings.modes[draft.id] = draft.billingMode;
            update[MODE_KEY] = settings.modes;
            if (draft.billingMode === "api") {
              settings.keys[draft.id] = draft.value;
              update[KEY] = settings.keys;
            }
            return writeSettings(update);
          });
        }).then(function () { return requireSameAccount(draft.id); }).then(function () {
          sendResponse({ ok: true, opened: true, saved: true, billingMode: draft.billingMode });
        });
      });
    }).catch(function (error) {
      var message = (error && error.message) || "无法保存视频 API 配置。";
      sendResponse({ ok: false, code: error && error.code, error: message, message: message });
    });
    return true;
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
