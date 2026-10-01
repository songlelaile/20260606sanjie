/* 视频工作台在网站上的账号与豆包密钥入口。密钥只留在当前浏览器。 */
(function (global) {
  "use strict";

  var KEY = "sz_web_video_api_key_v1";

  function readMap() {
    return new Promise(function (resolve) {
      global.chrome.storage.local.get([KEY], function (stored) {
        var value = stored && stored[KEY];
        resolve(value && typeof value === "object" ? value : {});
      });
    });
  }

  function writeMap(map) {
    return new Promise(function (resolve) {
      var update = {};
      update[KEY] = map;
      global.chrome.storage.local.set(update, function () { resolve(); });
    });
  }

  function accountId(auth) {
    var user = auth && auth.user;
    return user && (user.id || user.username) || "";
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
    var map = await readMap();
    var apiKey = typeof map[id] === "string" ? map[id].trim() : "";
    if (!apiKey) {
      return { ok: false, code: "CREDENTIALS_UNAVAILABLE", error: "当前账号尚未配置豆包 / 火山方舟 API Key。" };
    }
    return {
      ok: true,
      accountKey: id,
      user: auth.user,
      config: { apiKey: apiKey, provider: "doubao" }
    };
  };

  function openDialog() {
    return new Promise(function (resolve) {
      var existing = global.document.getElementById("sz-web-video-key-dialog");
      if (existing) existing.remove();
      var dialog = global.document.createElement("dialog");
      dialog.id = "sz-web-video-key-dialog";
      dialog.style.cssText = "border:1px solid #31411f;border-radius:16px;background:#10170b;color:#f4f7ea;padding:0;max-width:440px;width:calc(100% - 32px);";
      dialog.innerHTML = ''
        + '<form method="dialog" style="display:grid;gap:12px;padding:20px;">'
        + '<strong style="font-size:18px;">配置豆包 / 火山方舟</strong>'
        + '<p style="margin:0;color:#c9d3b4;line-height:1.5;">密钥只保存在这台浏览器的当前登录账号里，不会写入页面源码。网站只负责转发到火山方舟。</p>'
        + '<label style="display:grid;gap:6px;">API Key<input name="apiKey" type="password" autocomplete="off" style="min-height:40px;border-radius:8px;border:1px solid #31411f;background:#0b1007;color:#fff;padding:0 10px;"></label>'
        + '<div style="display:flex;justify-content:flex-end;gap:8px;">'
        + '<button value="cancel" type="submit" style="min-height:36px;border-radius:8px;border:1px solid #31411f;background:transparent;color:#f4f7ea;padding:0 12px;">取消</button>'
        + '<button value="save" type="submit" style="min-height:36px;border-radius:8px;border:0;background:#d6f36b;color:#141b07;font-weight:700;padding:0 14px;">保存</button>'
        + '</div></form>';
      global.document.body.appendChild(dialog);
      var input = dialog.querySelector("input");
      dialog.showModal();
      if (input) input.focus();
      dialog.addEventListener("close", function () {
        var saved = dialog.returnValue === "save";
        var value = input ? input.value.trim() : "";
        dialog.remove();
        resolve(saved ? value : "");
      }, { once: true });
    });
  }

  global.chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.type !== "OPEN_UNIFIED_API_SETTINGS") return false;
    openDialog().then(function (apiKey) {
      if (!apiKey) {
        sendResponse({ ok: false, error: "已取消视频 API 配置。" });
        return;
      }
      return global.authCheck().then(function (auth) {
        var id = accountId(auth);
        if (!auth || !auth.ok || !id) {
          sendResponse({ ok: false, error: "无法确定当前登录账号。" });
          return;
        }
        return readMap().then(function (map) {
          map[id] = apiKey;
          return writeMap(map);
        }).then(function () {
          sendResponse({ ok: true, opened: true, saved: true });
        });
      });
    }).catch(function (error) {
      sendResponse({ ok: false, error: (error && error.message) || "无法保存视频 API 配置。" });
    });
    return true;
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
