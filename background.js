"use strict";

/**
 * Chạy trong MAIN world của trang tiktok.com.
 * Gọi đúng endpoint mà TikTok Web dùng để bỏ yêu thích (unfavorite).
 *
 * Trả về: { ok, httpStatus?, statusCode?, errorCode?, error?, raw? }
 */
async function removeFavoriteMain(itemId) {
  function readContext() {
    let data = window.__$UNIVERSAL_DATA$__ || null;
    if (!data || !data.__DEFAULT_SCOPE__) {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (el && el.textContent) {
        try {
          data = JSON.parse(el.textContent);
        } catch (_) {
          data = null;
        }
      }
    }
    const ctx =
      data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__["webapp.app-context"];
    return {
      secUid: (ctx && ctx.user && ctx.user.secUid) || "",
      csrfToken: (ctx && ctx.csrfToken) || "",
    };
  }

  const { secUid, csrfToken } = readContext();
  if (!secUid) {
    return { ok: false, errorCode: "NO_SESSION" };
  }

  const params = new URLSearchParams({
    aid: "1988",
    action: "2",
    itemId: String(itemId),
    secUid: secUid,
  });

  const headers = {
    accept: "*/*",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (csrfToken) headers["tt-csrf-token"] = csrfToken;

  try {
    const res = await fetch(
      "https://www.tiktok.com/api/item/collect/?" + params.toString(),
      {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: "",
      }
    );

    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch (_) {
      json = null;
    }

    if (!res.ok) {
      let errorCode = "HTTP_ERROR";
      if (res.status === 429) errorCode = "RATE_LIMITED";
      else if (res.status === 401 || res.status === 403) errorCode = "SESSION_REJECTED";
      return {
        ok: false,
        errorCode,
        httpStatus: res.status,
        raw: String(raw).slice(0, 300),
      };
    }

    if (json && typeof json.status_code === "number" && json.status_code !== 0) {
      return {
        ok: false,
        errorCode: "TIKTOK_REJECTED",
        httpStatus: res.status,
        statusCode: json.status_code,
        raw: String(raw).slice(0, 300),
      };
    }

    return {
      ok: true,
      httpStatus: res.status,
      statusCode: json ? json.status_code : null,
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: "NETWORK_ERROR",
      error: String((err && err.message) || err),
    };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.action !== "string") return false;

  if (msg.action === "removeViaApi") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, errorCode: "NO_TAB" });
      return false;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        func: removeFavoriteMain,
        args: [msg.itemId],
      },
      (results) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            ok: false,
            errorCode: "INJECT_ERROR",
            error: String(chrome.runtime.lastError.message || chrome.runtime.lastError),
          });
          return;
        }
        const result = results && results[0] && results[0].result;
        sendResponse(result || { ok: false, errorCode: "NO_RESULT" });
      }
    );
    return true; // async
  }

  return false;
});