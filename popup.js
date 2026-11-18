"use strict";

const $ = (id) => document.getElementById(id);

const DEFAULTS = { method: "auto", delayMs: 700 };
let config = { ...DEFAULTS };

// ---------------------------------------------------------------------------
// Cấu hình
// ---------------------------------------------------------------------------
function applyConfig() {
  $("method").value = config.method;
  $("delay").value = String(config.delayMs);
  $("delayVal").textContent = (config.delayMs / 1000).toFixed(1) + "s";
}

function loadConfig() {
  try {
    chrome.storage.local.get(["tfcConfig"], (data) => {
      if (data && data.tfcConfig) {
        config = { ...DEFAULTS, ...data.tfcConfig };
      }
      applyConfig();
    });
  } catch (_) {
    applyConfig();
  }
}

function saveConfig() {
  try {
    chrome.storage.local.set({ tfcConfig: config });
  } catch (_) {}
}

$("method").addEventListener("change", () => {
  config.method = $("method").value;
  saveConfig();
});

$("delay").addEventListener("input", () => {
  config.delayMs = Number($("delay").value);
  $("delayVal").textContent = (config.delayMs / 1000).toFixed(1) + "s";
  saveConfig();
});

// ---------------------------------------------------------------------------
// Lấy tab TikTok hiện tại
// ---------------------------------------------------------------------------
async function getActiveTikTokTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) return null;
  const url = tab.url || "";
  if (/^https:\/\/www\.tiktok\.com\//.test(url)) return tab;
  return null;
}

function setStatus(text) {
  $("status").textContent = text;
}

// ---------------------------------------------------------------------------
// Gửi lệnh tới content script; nếu chưa có thì tự inject rồi thử lại.
// ---------------------------------------------------------------------------
async function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      const err = chrome.runtime.lastError;
      if (!err) {
        resolve({ ok: true, resp });
        return;
      }
      // Có thể tab đã mở từ trước khi cài extension → tự inject.
      chrome.scripting
        .executeScript({ target: { tabId }, files: ["content.js"] })
        .then(() => {
          chrome.tabs.sendMessage(tabId, message, (resp2) => {
            const err2 = chrome.runtime.lastError;
            if (err2) {
              resolve({ ok: false, error: String(err2.message || err2) });
              return;
            }
            resolve({ ok: true, resp: resp2 });
          });
        })
        .catch((e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    });
  });
}

async function start(mode) {
  const tab = await getActiveTikTokTab();
  if (!tab) {
    await chrome.tabs.create({ url: "https://www.tiktok.com/profile" });
    setStatus("Đã mở TikTok. Hãy đăng nhập, vào Favorites rồi bấm lại.");
    return;
  }

  saveConfig();

  const r = await sendToTab(tab.id, {
    action: "tfc:start",
    config: { mode, method: config.method, delayMs: config.delayMs },
  });

  if (!r.ok) {
    setStatus("Không kết nối được với trang. Hãy tải lại tab TikTok rồi thử lại.");
    return;
  }
  setStatus(
    r.resp && r.resp.ok
      ? "Đã bắt đầu. Xem panel trên trang TikTok."
      : "Không thể bắt đầu."
  );
}

$("dryrunBtn").addEventListener("click", () => start("dryrun"));
$("removeBtn").addEventListener("click", () => start("remove"));
$("stopBtn").addEventListener("click", async () => {
  const tab = await getActiveTikTokTab();
  if (!tab) {
    setStatus("Không tìm thấy tab TikTok.");
    return;
  }
  await sendToTab(tab.id, { action: "tfc:stop" });
  setStatus("Đã gửi lệnh dừng.");
});

// ---------------------------------------------------------------------------
// Nhận tiến độ từ content script
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.action !== "tfc:progress") return;
  const s = msg.state || {};
  const done = s.processed || 0;
  const total = s.total || 0;
  let line = s.status || "";
  if (total > 0) {
    line += `  (${done}/${total})`;
  }
  setStatus(line);

  const running = !!s.running;
  $("stopBtn").hidden = !running;
  $("dryrunBtn").disabled = running;
  $("removeBtn").disabled = running;
});

// ---------------------------------------------------------------------------
// Khởi tạo
// ---------------------------------------------------------------------------
loadConfig();

// Đồng bộ trạng thái ban đầu
(async () => {
  const tab = await getActiveTikTokTab();
  if (!tab) {
    setStatus("Mở tiktok.com và đăng nhập để bắt đầu.");
    return;
  }
  const r = await sendToTab(tab.id, { action: "tfc:getStatus" });
  if (!r.ok) {
    setStatus("Sẵn sàng. Nhấn Chạy thử hoặc Xoá tất cả.");
    return;
  }
  const resp = r.resp;
  if (resp && resp.status) {
    const running = !!resp.running;
    setStatus(resp.status);
    $("stopBtn").hidden = !running;
    $("dryrunBtn").disabled = running;
    $("removeBtn").disabled = running;
  }
})();