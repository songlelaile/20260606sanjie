/* 网站视频使用服务端供应；保留当前账号已有的外部视频配置。 */
(function (global) {
  "use strict";

  var KEY = "sz_web_video_api_key_v1";
  var MODE_KEY = "sz_web_video_billing_mode_v1";

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
      var analysisBase = "https://sub.shaozhuangai.com/v1";
      if (!global.SZ_WEB_SUPPLY || typeof global.SZ_WEB_SUPPLY.usesServerCredentials !== "function" ||
          !global.SZ_WEB_SUPPLY.usesServerCredentials(analysisBase + "/chat/completions")) {
        return { ok: false, accountKey: id, code: "ANALYZER_CONFIG_UNAVAILABLE", error: "平台脚本分析连接不可用，请刷新后重试。" };
      }
      return { ok: true, accountKey: id, user: auth.user,
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
        var nativeModels = platform.models.filter(function (model) {
          return model && ["seedance-2.0-mini", "seedance-2.0-fast", "seedance-2.0", "seedance-2.5"].indexOf(model.id) >= 0 &&
            Array.isArray(model.durations) && model.durations.length &&
            Array.isArray(model.resolutions) && model.resolutions.length && Array.isArray(model.ratios) && model.ratios.length;
        }).map(function (model) {
          return { id: model.id, providerModel: model.id, durations: model.durations.slice(),
            resolutions: model.resolutions.slice(), ratios: model.ratios.slice(), generateAudio: model.generateAudio === true,
            reservationCents: Number.isSafeInteger(model.reservationCents) && model.reservationCents > 0 ? model.reservationCents : null };
        });
        if (nativeModels.length) {
          return { ok: true, accountKey: id, user: checked.user, config: { apiKey: "", provider: "shaozhuang-native", platformVideo: true,
            platformModels: nativeModels, maxBodyBytes: Math.min(24 * 1024 * 1024, Number(platform.limits && platform.limits.bodyBytes) || 24 * 1024 * 1024) } };
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
