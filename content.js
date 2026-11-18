(() => {
  "use strict";

  if (window.__tfcLoaded) return;
  window.__tfcLoaded = true;

  // ---------------------------------------------------------------------------
  // Tiện ích
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Số lỗi liên tiếp tối đa trước khi tự dừng (tránh chạy vô ích khi TikTok đổi giao diện).
  const MAX_CONSECUTIVE_FAILURES = 5;

  // ---------------------------------------------------------------------------
  // Trạng thái
  // ---------------------------------------------------------------------------
  const state = {
    running: false,
    phase: "idle", // idle | enumerating | ready | removing | done | error
    mode: "dryrun", // dryrun | remove
    method: "auto", // auto | api | ui
    delayMs: 700,
    items: [],
    queue: [],
    processed: 0,
    removed: 0,
    failed: 0,
    skipped: 0,
    paused: false,
    cancelled: false,
    status: "Sẵn sàng",
    log: [],
    confirmOpen: false,
    haltReason: null,
    runId: 0,
  };

  // ---------------------------------------------------------------------------
  // Panel (Shadow DOM để không đụng CSS của TikTok)
  // ---------------------------------------------------------------------------
  let panel = null;

  function makeStat(label, id) {
    const span = document.createElement("span");
    span.appendChild(document.createTextNode(label + ": "));
    const b = document.createElement("b");
    b.id = id;
    b.textContent = "0";
    span.appendChild(b);
    return span;
  }

  function makeBtn(id, text, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tfc-btn" + (cls ? " " + cls : "");
    b.id = id;
    b.textContent = text;
    return b;
  }

  function createPanel() {
    if (panel) return panel;

    const host = document.createElement("div");
    host.id = "tfc-host";
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.top = "0";
    host.style.left = "0";

    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .tfc {
        position: fixed; top: 16px; right: 16px; width: 344px;
        background: #15151b; color: #f4f4f6; border-radius: 14px;
        box-shadow: 0 12px 44px rgba(0,0,0,.5); overflow: hidden;
        border: 1px solid #2a2a35; font-size: 13px; z-index: 2147483647;
      }
      .tfc-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 11px 14px; background: #1d1d26; border-bottom: 1px solid #2a2a35;
      }
      .tfc-title { font-weight: 600; letter-spacing: .2px; display: flex; align-items: center; }
      .tfc-dot { width: 8px; height: 8px; border-radius: 50%; background: #3ddc84; display: inline-block; margin-right: 7px; }
      .tfc-body { padding: 12px 14px 14px; }
      .tfc-status { font-size: 13px; line-height: 1.45; color: #d6d6e0; min-height: 34px; }
      .tfc-bar { height: 6px; background: #2a2a35; border-radius: 999px; overflow: hidden; margin: 10px 0; }
      .tfc-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #fe2c55, #ff7a9e); transition: width .25s ease; }
      .tfc-stats { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: #9a9aa8; margin-bottom: 10px; }
      .tfc-stats b { color: #f4f4f6; }
      .tfc-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .tfc-btn {
        flex: 1 1 0; min-width: 0; padding: 8px 10px; border-radius: 8px;
        border: 1px solid #34343f; background: #23232c; color: #f4f4f6;
        font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
      }
      .tfc-btn:hover { background: #2b2b36; }
      .tfc-btn.primary { background: #fe2c55; border-color: #fe2c55; color: #fff; }
      .tfc-btn.danger { background: #3a1d25; border-color: #5a2b36; color: #ff8fa6; }
      .tfc-btn:disabled { opacity: .45; cursor: not-allowed; }
      .tfc-log {
        margin: 10px 0 0; max-height: 108px; overflow: auto; background: #0f0f14;
        border: 1px solid #24242e; border-radius: 8px; padding: 8px; font-size: 11px;
        color: #8f8f9d; white-space: pre-wrap; word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      }
    `;
    shadow.appendChild(style);

    const root = document.createElement("div");
    root.className = "tfc";

    const head = document.createElement("div");
    head.className = "tfc-head";
    const title = document.createElement("div");
    title.className = "tfc-title";
    const dot = document.createElement("span");
    dot.className = "tfc-dot";
    title.appendChild(dot);
    title.appendChild(document.createTextNode("TikTok Favorites Cleaner"));
    head.appendChild(title);

    const body = document.createElement("div");
    body.className = "tfc-body";

    const status = document.createElement("div");
    status.className = "tfc-status";
    status.id = "tfcStatus";
    status.textContent = "Sẵn sàng";

    const bar = document.createElement("div");
    bar.className = "tfc-bar";
    const fill = document.createElement("div");
    fill.className = "tfc-fill";
    fill.id = "tfcFill";
    bar.appendChild(fill);

    const stats = document.createElement("div");
    stats.className = "tfc-stats";
    stats.appendChild(makeStat("Tổng", "tfcTotal"));
    stats.appendChild(makeStat("Đã xoá", "tfcRemoved"));
    stats.appendChild(makeStat("Bỏ qua", "tfcSkipped"));
    stats.appendChild(makeStat("Lỗi", "tfcFailed"));

    const actions = document.createElement("div");
    actions.className = "tfc-actions";
    const btnDryrun = makeBtn("tfcDryrun", "Chạy thử", "");
    const btnStart = makeBtn("tfcStart", "Xoá tất cả", "primary");
    const btnConfirm = makeBtn("tfcConfirm", "Xác nhận xoá", "primary");
    const btnPause = makeBtn("tfcPause", "Tạm dừng", "");
    const btnStop = makeBtn("tfcStop", "Dừng", "danger");
    const btnVerify = makeBtn("tfcVerify", "Kiểm tra lại", "");
    btnConfirm.hidden = true;
    btnPause.hidden = true;
    btnStop.hidden = true;
    btnVerify.hidden = true;
    actions.appendChild(btnDryrun);
    actions.appendChild(btnStart);
    actions.appendChild(btnConfirm);
    actions.appendChild(btnPause);
    actions.appendChild(btnStop);
    actions.appendChild(btnVerify);

    const logEl = document.createElement("pre");
    logEl.className = "tfc-log";
    logEl.id = "tfcLog";

    body.appendChild(status);
    body.appendChild(bar);
    body.appendChild(stats);
    body.appendChild(actions);
    body.appendChild(logEl);

    root.appendChild(head);
    root.appendChild(body);
    shadow.appendChild(root);

    document.documentElement.appendChild(host);

    panel = {
      host,
      shadow,
      status: shadow.querySelector("#tfcStatus"),
      fill: shadow.querySelector("#tfcFill"),
      total: shadow.querySelector("#tfcTotal"),
      removed: shadow.querySelector("#tfcRemoved"),
      skipped: shadow.querySelector("#tfcSkipped"),
      failed: shadow.querySelector("#tfcFailed"),
      log: shadow.querySelector("#tfcLog"),
      dryrun: shadow.querySelector("#tfcDryrun"),
      start: shadow.querySelector("#tfcStart"),
      confirm: shadow.querySelector("#tfcConfirm"),
      pause: shadow.querySelector("#tfcPause"),
      stop: shadow.querySelector("#tfcStop"),
      verify: shadow.querySelector("#tfcVerify"),
    };

    panel.dryrun.addEventListener("click", () => startJob("dryrun"));
    panel.start.addEventListener("click", () => startJob("remove"));
    panel.confirm.addEventListener("click", () => {
      // Chốt an toàn: chỉ cho phép khi đang thực sự chờ xác nhận.
      if (!state.confirmOpen) return;
      state.confirmOpen = false;
      runRemoval();
    });
    panel.pause.addEventListener("click", () => {
      state.paused = !state.paused;
      log(state.paused ? "Tạm dừng." : "Tiếp tục.");
      renderPanel();
    });
    panel.stop.addEventListener("click", () => stopJob());
    panel.verify.addEventListener("click", () => {
      try {
        sessionStorage.setItem("tfc_verify", "1");
      } catch (_) {}
      location.reload();
    });

    renderPanel();
    return panel;
  }

  function log(msg) {
    state.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (state.log.length > 200) state.log.shift();
    renderPanel();
  }

  function renderPanel() {
    if (!panel) return;
    const total = state.items.length || 0;
    const done = state.processed;
    panel.status.textContent = state.status;
    panel.total.textContent = String(total);
    panel.removed.textContent = String(state.removed);
    panel.skipped.textContent = String(state.skipped);
    panel.failed.textContent = String(state.failed);
    panel.fill.style.width = total ? `${Math.min(100, (done / total) * 100)}%` : "0%";
    panel.log.textContent = state.log.join("\n");
    panel.log.scrollTop = panel.log.scrollHeight;

    const showConfirm = state.confirmOpen;
    panel.start.hidden = state.running || showConfirm;
    panel.dryrun.hidden = state.running || showConfirm;
    panel.confirm.hidden = !showConfirm;
    panel.pause.hidden = !state.running || showConfirm;
    // Nút Dừng luôn hiện khi đang chạy KỂ CẢ lúc chờ xác nhận (để có thể huỷ).
    panel.stop.hidden = !state.running;
    panel.stop.textContent = showConfirm ? "Huỷ" : "Dừng";
    panel.verify.hidden = state.running || state.phase !== "done";
    panel.start.disabled = false;
    panel.dryrun.disabled = false;
  }

  // ---------------------------------------------------------------------------
  // Cấu hình lưu từ popup
  // ---------------------------------------------------------------------------
  function loadConfig() {
    try {
      chrome.storage.local.get(["tfcConfig"], (data) => {
        const cfg = data && data.tfcConfig;
        if (!cfg) return;
        if (cfg.method === "auto" || cfg.method === "api" || cfg.method === "ui") {
          state.method = cfg.method;
        }
        if (typeof cfg.delayMs === "number" && cfg.delayMs >= 200) {
          state.delayMs = cfg.delayMs;
        }
      });
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Gửi tiến độ cho popup
  // ---------------------------------------------------------------------------
  function summarize() {
    return {
      phase: state.phase,
      status: state.status,
      total: state.items.length,
      processed: state.processed,
      removed: state.removed,
      failed: state.failed,
      skipped: state.skipped,
      running: state.running,
    };
  }

  function sendProgress() {
    try {
      chrome.runtime.sendMessage({ action: "tfc:progress", state: summarize() }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Điều hướng tới Favorites
  // ---------------------------------------------------------------------------
  function favoritesGridPresent() {
    return !!document.querySelector(
      '[data-e2e="favorites-item"], [data-e2e="favorites-item-list"]'
    );
  }

  const FAVORITE_TAB_SELECTORS = [
    '[data-e2e="favorite-tab"]',
    '[data-e2e="favorites-tab"]',
    '[data-e2e="user-favorite-tab"]',
    '[role="tab"][data-e2e*="favorite" i]',
    '[role="tab"][class*="PFavorite"]',
    '[class*="PFavorite"]',
  ];

  function findFavoriteTab() {
    for (const s of FAVORITE_TAB_SELECTORS) {
      let el = null;
      try {
        el = document.querySelector(s);
      } catch (_) {
        el = null;
      }
      if (el) return el;
    }
    // Dự phòng: tìm tab theo chữ (Favorites / Yêu thích / 收藏)
    return (
      Array.from(document.querySelectorAll('[role="tab"], [data-e2e*="tab"]')).find((el) =>
        /favorite|favourites|yêu thích|收藏/i.test(el.textContent || "")
      ) || null
    );
  }

  // Trong Favorites còn có tab con "Posts"; bấm vào để chắc chắn đang ở lưới video.
  async function openPostsTab() {
    const posts = document.querySelector("#posts");
    if (!posts) return;
    if (posts.getAttribute("aria-selected") === "true") return;
    posts.click();
    await sleep(800);
  }

  async function ensureFavoritesView(navMode) {
    if (favoritesGridPresent()) return true;

    const tab = findFavoriteTab();
    if (tab) {
      const wasSelected = tab.getAttribute("aria-selected") === "true";
      if (!wasSelected) tab.click();

      // Chờ TikTok đổi tab (có thể mất 1-2 giây).
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const current = findFavoriteTab() || tab;
        if (current.getAttribute("aria-selected") === "true" || favoritesGridPresent()) {
          if (!wasSelected) await openPostsTab();
          // Chờ lưới render.
          const gridDeadline = Date.now() + 5000;
          while (Date.now() < gridDeadline) {
            if (favoritesGridPresent()) return true;
            await sleep(250);
          }
          break;
        }
        await sleep(250);
      }
    }

    // Chưa ở trang phù hợp → điều hướng và tự chạy lại sau khi tải xong.
    try {
      sessionStorage.setItem(
        "tfc_autostart",
        JSON.stringify({
          mode: navMode || state.mode || "dryrun",
          method: state.method,
          delayMs: state.delayMs,
        })
      );
    } catch (_) {}
    log("Đang mở trang Profile để vào Favorites...");
    location.href = "https://www.tiktok.com/profile";
    return false;
  }

  // ---------------------------------------------------------------------------
  // Liệt kê video trong Favorites
  // ---------------------------------------------------------------------------
  function extractItemsFromDom() {
    let anchors = Array.from(
      document.querySelectorAll(
        '[data-e2e="favorites-item"] a[href*="/video/"], [data-e2e="favorites-item"] a[href*="/photo/"]'
      )
    );

    if (!anchors.length) {
      anchors = Array.from(
        document.querySelectorAll(
          '[data-e2e="favorites-item-list"] a[href*="/video/"], [data-e2e="favorites-item-list"] a[href*="/photo/"]'
        )
      );
    }
    if (!anchors.length) {
      anchors = Array.from(
        document.querySelectorAll('#posts a[href*="/video/"], #posts a[href*="/photo/"]')
      );
    }

    const map = new Map();
    for (const a of anchors) {
      const href = a.href || a.getAttribute("href") || "";
      const m = href.match(/\/@([^/]+)\/(?:video|photo)\/(\d+)/i);
      if (!m) continue;
      map.set(m[2], {
        id: m[2],
        authorName: "@" + decodeURIComponent(m[1]),
        url: href.split("?")[0],
        desc: (a.querySelector("img") && a.querySelector("img").alt) || a.getAttribute("aria-label") || "",
      });
    }
    return Array.from(map.values());
  }

  function getExpectedCount() {
    const el = document.querySelector("#posts");
    if (!el) return null;
    const text = el.textContent || "";
    // "Posts 123" / "Posts 1.2K" / "123"
    const match = text.match(/(\d[\d.,]*?)(?:\s*([KMB]))?(?=\s|$)/i);
    if (!match) return null;
    if (!match[2]) {
      const n = Number(match[1].replace(/[^\d]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[match[2].toUpperCase()];
    const decimal = match[1].replace(",", ".");
    const displayed = Number(decimal);
    if (!Number.isFinite(displayed)) return null;
    // Số hiển thị dạng gọn (1.2K) bị làm tròn → lấy cận dưới.
    const precision = (decimal.split(".")[1] || "").length;
    return Math.max(0, Math.ceil((displayed - 0.5 * Math.pow(10, -precision)) * multiplier));
  }

  async function enumerateItems() {
    const items = new Map();
    let prevCount = -1;
    let prevHeight = -1;
    let stable = 0;
    let highestExpected = 0;

    for (let cycle = 0; cycle < 300; cycle++) {
      if (state.cancelled) break;

      const batch = extractItemsFromDom();
      for (const it of batch) items.set(it.id, it);

      const expected = getExpectedCount();
      if (expected !== null) highestExpected = Math.max(highestExpected, expected);
      const height = document.body.scrollHeight;

      if (items.size === prevCount && height === prevHeight) stable++;
      else stable = 0;
      prevCount = items.size;
      prevHeight = height;

      window.scrollTo(0, height);

      // Chỉ coi số đếm là "đã đủ" khi nó > 0 (TikTok có lúc hiện "Posts 0" trong lúc tải).
      if (expected !== null && expected > 0 && items.size >= expected) break;
      // Nếu đã biết tổng số mà lưới vẫn thiếu → cho thêm thời gian trước khi kết luận.
      const threshold = highestExpected > items.size ? 10 : 6;
      if (stable >= threshold) break;

      await sleep(700);
    }

    window.scrollTo(0, 0);
    return Array.from(items.values());
  }

  // ---------------------------------------------------------------------------
  // Cơ chế A: gọi API qua background (MAIN world)
  // ---------------------------------------------------------------------------
  function removeViaApi(item) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      try {
        chrome.runtime.sendMessage({ action: "removeViaApi", itemId: item.id }, (resp) => {
          if (chrome.runtime.lastError) {
            done({
              ok: false,
              errorCode: "IPC_ERROR",
              error: String(chrome.runtime.lastError.message || chrome.runtime.lastError),
            });
            return;
          }
          done(resp || { ok: false, errorCode: "NO_RESPONSE" });
        });
      } catch (e) {
        done({ ok: false, errorCode: "IPC_ERROR", error: String(e) });
      }

      setTimeout(() => done({ ok: false, errorCode: "TIMEOUT" }), 30000);
    });
  }

  // ---------------------------------------------------------------------------
  // Cơ chế B: bấm nút bookmark trong giao diện
  // ---------------------------------------------------------------------------
  function findBookmarkButton() {
    const selectors = [
      '[data-e2e="bookmark-icon"]',
      '[data-e2e="collect-icon"]',
      '[data-e2e="favorites-icon"]',
      '[data-e2e="browse-bookmark"]',
      '[data-e2e="video-player-bookmark"]',
      '[data-e2e="undefined-icon"]',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el.closest("button, [role='button']") || el;
    }
    const byLabel = Array.from(document.querySelectorAll("button[aria-label]")).find((b) =>
      /favorite|favourite|bookmark|yêu thích|đã lưu|收藏/i.test(b.getAttribute("aria-label") || "")
    );
    return byLabel || null;
  }

  // Nhãn có thể là tiếng Anh hoặc tiếng Việt tuỳ cài đặt tài khoản.
  function isBookmarkSaved(btn) {
    if (!btn) return null;
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (/remove from favorites|unfavorite|remove favorite|bỏ yêu thích|bỏ lưu/.test(label)) return true;
    if (/add to favorites|favorite|thêm vào yêu thích|lưu vào yêu thích/.test(label)) return false;
    if (/favorited|đã thích|đã lưu/.test(label)) return true;

    const pressed = btn.getAttribute("aria-pressed");
    if (pressed === "true") return true;
    if (pressed === "false") return false;

    const svg = btn.querySelector("svg");
    if (svg) {
      const cls = (svg.getAttribute("class") || "") + " " + (svg.getAttribute("fill") || "");
      if (/filled|active|saved|is-active/i.test(cls)) return true;
      if (/outline|unfilled/i.test(cls)) return false;
    }
    return null;
  }

  function findCardElement(itemId) {
    const links = document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]');
    for (const a of links) {
      const href = a.href || a.getAttribute("href") || "";
      const m = href.match(/\/(?:video|photo)\/(\d+)/i);
      if (m && m[1] === String(itemId)) {
        return (
          a.closest('[data-e2e="favorites-item"]') ||
          a.closest('[data-e2e="favorites-item-list"]') ||
          a.closest("li") ||
          a
        );
      }
    }
    return null;
  }

  const UI_RESUME_KEY = "tfc_ui_resume";
  const UI_RESUME_MAX_AGE_MS = 5 * 60 * 1000;

  function clearUiResume() {
    try {
      sessionStorage.removeItem(UI_RESUME_KEY);
    } catch (_) {}
  }

  // Nếu bấm card khiến TikTok tải lại cả trang, panel sẽ mất.
  // Ta chỉ ghi lại mốc thời gian để lần sau nhắc người dùng — TUYỆT ĐỐI không tự xoá.
  function markUiResume() {
    try {
      sessionStorage.setItem(UI_RESUME_KEY, JSON.stringify({ at: Date.now() }));
    } catch (_) {}
  }

  async function waitForBookmarkButton(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      const btn = findBookmarkButton();
      if (btn) return btn;
      await sleep(200);
    }
    return null;
  }

  function closeModal() {
    const closeBtn = document.querySelector(
      'button[aria-label="exit"], button[aria-label="close"], [data-e2e="close-icon"]'
    );
    if (closeBtn) {
      closeBtn.click();
      return;
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
    );
  }

  async function removeViaUi(item, runId) {
    const isStale = () => runId !== undefined && runId !== state.runId;
    const card = findCardElement(item.id);
    if (!card) return { ok: false, errorCode: "CARD_NOT_FOUND" };

    card.scrollIntoView({ block: "center" });
    await sleep(250);
    if (isStale()) return { ok: false, errorCode: "CANCELLED" };

    // Đánh dấu trước khi bấm: nếu TikTok tải lại cả trang, panel sẽ mất.
    markUiResume();
    card.click();

    const btn = await waitForBookmarkButton(8000);
    if (isStale()) return { ok: false, errorCode: "CANCELLED" };
    if (!btn) {
      closeModal();
      clearUiResume();
      return { ok: false, errorCode: "BOOKMARK_NOT_FOUND" };
    }

    const beforeSaved = isBookmarkSaved(btn);
    // Đang mở từ grid Favorites nên video gần như chắc chắn đã được lưu.
    // Chỉ bỏ qua khi chắc chắn (false) là chưa lưu, tránh bấm nhầm thành "thêm".
    if (beforeSaved === false) {
      closeModal();
      clearUiResume();
      return { ok: true, skipped: true };
    }

    const beforeLabel = btn.getAttribute("aria-label") || "";
    const beforeHtml = btn.innerHTML;
    btn.click();
    await sleep(Math.max(700, state.delayMs));
    if (isStale()) return { ok: false, errorCode: "CANCELLED" };

    const after = findBookmarkButton();
    if (!after) {
      closeModal();
      clearUiResume();
      return { ok: true };
    }

    const afterSaved = isBookmarkSaved(after);
    const afterLabel = after.getAttribute("aria-label") || "";
    const changed = afterLabel !== beforeLabel || after.innerHTML !== beforeHtml;

    closeModal();
    clearUiResume();

    if (afterSaved === false || changed) return { ok: true };
    return { ok: false, errorCode: "UI_UNVERIFIED" };
  }

  function isRetryableRemovalError(r) {
    if (!r) return false;
    if (r.errorCode === "NETWORK_ERROR" || r.errorCode === "TIMEOUT") return true;
    return r.errorCode === "HTTP_ERROR" && Number(r.httpStatus) >= 500;
  }

  // Gọi API có thử lại (tối đa 3 lần) với backoff khi lỗi mạng/timeout/5xx.
  async function removeViaApiWithRetry(item, runId, maxAttempts = 3) {
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (state.cancelled || (runId !== undefined && runId !== state.runId)) {
        return { ok: false, errorCode: "CANCELLED" };
      }
      last = await removeViaApi(item);
      if (runId !== undefined && runId !== state.runId) {
        return { ok: false, errorCode: "CANCELLED" };
      }
      if (last && last.ok) return last;
      if (!isRetryableRemovalError(last) || attempt === maxAttempts) return last;
      const backoff = 1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
      log(`Thử lại ${item.id} sau ${backoff}ms (${(last && last.errorCode) || "?"})`);
      await sleep(backoff);
    }
    return last;
  }

  async function removeOne(item, runId) {
    if (state.method === "api" || state.method === "auto") {
      const r = await removeViaApiWithRetry(item, runId);
      if (runId !== undefined && runId !== state.runId) return r || { ok: false, errorCode: "CANCELLED" };
      if (r && r.ok) return r;
      if (state.method === "api") return r;
      if (r && (r.errorCode === "RATE_LIMITED" || r.errorCode === "SESSION_REJECTED")) return r;
      log(`API lỗi (${(r && r.errorCode) || "?"}) → chuyển sang giao diện cho ${item.id}`);
    }
    return removeViaUi(item, runId);
  }

  // ---------------------------------------------------------------------------
  // Vòng lặp chính
  // ---------------------------------------------------------------------------
  async function waitWhilePaused() {
    while (state.paused) {
      if (state.cancelled) return;
      await sleep(200);
    }
  }

  async function startJob(mode, opts) {
    // Đang quét, đang chờ xác nhận, hoặc đang xoá → không chen ngang bằng lần chạy mới.
    if (state.phase === "enumerating" || state.phase === "ready" || state.phase === "removing") {
      return;
    }
    createPanel();

    if (opts) {
      if (opts.method) state.method = opts.method;
      if (typeof opts.delayMs === "number") state.delayMs = opts.delayMs;
    }

    const runId = ++state.runId;

    state.running = true;
    state.phase = "enumerating";
    state.mode = mode;
    state.cancelled = false;
    state.paused = false;
    state.items = [];
    state.queue = [];
    state.processed = 0;
    state.removed = 0;
    state.failed = 0;
    state.skipped = 0;
    state.log = [];
    state.confirmOpen = false;
    state.haltReason = null;
    state.status = "Đang quét danh sách Yêu thích...";
    renderPanel();
    sendProgress();

    try {
      const ok = await ensureFavoritesView();
      if (!ok) return; // đang điều hướng, sẽ tự chạy lại
      if (runId !== state.runId || state.cancelled) return;

      const items = await enumerateItems();
      if (runId !== state.runId) return;
      state.items = items;

      if (state.cancelled) {
        state.running = false;
        state.phase = "idle";
        state.status = "Đã dừng.";
        renderPanel();
        sendProgress();
        return;
      }

      log(`Tìm thấy ${items.length} video trong Yêu thích.`);

      if (!items.length) {
        state.status = "Không tìm thấy video. Hãy mở đúng Profile → Favorites → Posts.";
        state.running = false;
        state.phase = "done";
        renderPanel();
        sendProgress();
        return;
      }

      if (mode === "dryrun") {
        state.status = `Chạy thử: ${items.length} video sẽ bị xoá (chưa xoá gì).`;
        state.phase = "done";
        state.running = false;
        log("Dry-run hoàn tất — không có thay đổi nào được thực hiện.");
        renderPanel();
        sendProgress();
        return;
      }

      state.status = `Sẽ xoá ${items.length} video. Hãy xác nhận.`;
      state.phase = "ready";
      state.confirmOpen = true;
      state.running = true; // vẫn đang chờ người dùng bấm xác nhận
      renderPanel();
      sendProgress();
    } catch (e) {
      if (runId !== state.runId) return;
      state.phase = "error";
      state.status = "Lỗi: " + ((e && e.message) || e);
      state.running = false;
      renderPanel();
      sendProgress();
    }
  }

  async function runRemoval() {
    if (state.phase === "removing") return;
    state.confirmOpen = false;
    state.running = true;
    state.phase = "removing";

    const runId = state.runId;

    state.queue = state.items.slice();
    state.processed = 0;
    state.removed = 0;
    state.failed = 0;
    state.skipped = 0;
    state.paused = false;
    state.haltReason = null;
    renderPanel();

    let consecutiveFailures = 0;

    for (const item of state.queue) {
      if (state.cancelled || runId !== state.runId) break;
      await waitWhilePaused();
      if (state.cancelled || runId !== state.runId) break;

      state.status = `Đang xoá ${item.authorName} (${item.id})`;
      renderPanel();

      let result;
      try {
        result = await removeOne(item, runId);
      } catch (e) {
        result = { ok: false, errorCode: "EXCEPTION", error: String(e) };
      }

      // Nếu lần chạy đã bị thay (Dừng rồi Start lại) → dừng ngay, không đụng vào state mới.
      if (runId !== state.runId) return;

      state.processed++;
      if (result && result.ok) {
        state.removed++;
        consecutiveFailures = 0;
      } else if (result && result.skipped) {
        state.skipped++;
        consecutiveFailures = 0;
      } else {
        state.failed++;
        consecutiveFailures++;
      }

      const tag = result && result.ok ? "OK" : result && result.skipped ? "SKIP" : "FAIL";
      log(`${tag} ${item.id} ${(result && result.errorCode) || ""}`.trim());

      renderPanel();
      sendProgress();

      if (result && (result.errorCode === "RATE_LIMITED" || result.errorCode === "SESSION_REJECTED")) {
        log(`Dừng vì ${result.errorCode}. Hãy chờ ~1 giờ rồi thử lại.`);
        state.haltReason = result.errorCode;
        break;
      }

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log(`Dừng vì ${consecutiveFailures} lỗi liên tiếp.`);
        state.haltReason = "TOO_MANY_FAILURES";
        break;
      }

      await sleep(state.delayMs);
    }

    await finish(runId);
  }

  async function finish(runId) {
    // Bỏ qua nếu đây là vòng lặp cũ đã bị thay bằng lần chạy mới.
    if (runId !== undefined && runId !== state.runId) return;

    state.running = false;
    state.phase = "done";

    if (state.cancelled) {
      state.status = `Đã dừng: đã xoá ${state.removed}, lỗi ${state.failed}, bỏ qua ${state.skipped}.`;
      log("Đã dừng theo yêu cầu. Bấm 'Kiểm tra lại' để xem còn lại bao nhiêu.");
      renderPanel();
      sendProgress();
      return;
    }

    if (state.haltReason === "RATE_LIMITED") {
      state.status = `Tạm dừng: TikTok giới hạn tần suất (429). Đã xoá ${state.removed}.`;
      log("TikTok chặn tạm thời. Hãy chờ khoảng 1 giờ rồi chạy lại.");
      renderPanel();
      sendProgress();
      return;
    }

    if (state.haltReason === "SESSION_REJECTED") {
      state.status = `Tạm dừng: TikTok từ chối phiên đăng nhập (401/403). Đã xoá ${state.removed}.`;
      log("Hãy tải lại trang, kiểm tra đăng nhập rồi chạy lại.");
      renderPanel();
      sendProgress();
      return;
    }

    if (state.haltReason === "TOO_MANY_FAILURES") {
      state.status = `Tạm dừng sau ${MAX_CONSECUTIVE_FAILURES} lỗi liên tiếp. Đã xoá ${state.removed}.`;
      log("Có quá nhiều lỗi liên tiếp — có thể TikTok đã đổi giao diện/endpoint.");
      renderPanel();
      sendProgress();
      return;
    }

    state.status = `Hoàn tất: đã xoá ${state.removed}, lỗi ${state.failed}, bỏ qua ${state.skipped}.`;
    log("Hoàn tất. Bấm 'Kiểm tra lại' để tải lại trang và xác nhận.");
    renderPanel();
    sendProgress();
  }

  function stopJob() {
    state.cancelled = true;
    state.paused = false;
    state.running = false;
    state.confirmOpen = false;
    state.phase = "idle";
    state.status = "Đã dừng.";
    state.runId++; // vô hiệu hoá vòng lặp đang chạy
    log("Đã dừng.");
    renderPanel();
    sendProgress();
  }

  // ---------------------------------------------------------------------------
  // Nhận lệnh từ popup
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.action !== "string") return false;

    if (msg.action === "tfc:start") {
      const cfg = msg.config || {};
      startJob(cfg.mode === "remove" ? "remove" : "dryrun", cfg);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.action === "tfc:stop") {
      stopJob();
      sendResponse({ ok: true });
      return false;
    }

    if (msg.action === "tfc:getStatus") {
      sendResponse(summarize());
      return false;
    }

    return false;
  });

  // ---------------------------------------------------------------------------
  // Tự chạy lại sau khi điều hướng / sau khi xác minh
  // ---------------------------------------------------------------------------
  async function handlePendingFlags() {
    let pending = null;
    let verify = false;
    let uiResume = null;
    try {
      const raw = sessionStorage.getItem("tfc_autostart");
      if (raw) {
        sessionStorage.removeItem("tfc_autostart");
        pending = JSON.parse(raw);
      }
      if (sessionStorage.getItem("tfc_verify")) {
        sessionStorage.removeItem("tfc_verify");
        verify = true;
      }
      const rawUi = sessionStorage.getItem(UI_RESUME_KEY);
      if (rawUi) {
        sessionStorage.removeItem(UI_RESUME_KEY);
        uiResume = JSON.parse(rawUi);
      }
    } catch (_) {}

    if (uiResume) {
      // Trang vừa tải lại giữa lúc bấm nút bookmark. KHÔNG tự xoá —
      // chỉ hiện panel và báo để người dùng tự quyết định.
      clearUiResume();
      const age = Date.now() - (Number(uiResume && uiResume.at) || 0);
      if (age > UI_RESUME_MAX_AGE_MS) return; // quá cũ → bỏ qua
      await sleep(1200);
      createPanel();
      state.phase = "idle";
      state.status = "Trang đã tải lại giữa lúc xoá. Kiểm tra kết quả rồi chạy tiếp nếu cần.";
      log("Phát hiện lần chạy trước bị ngắt do trang tải lại. Không tự động xoá tiếp.");
      renderPanel();
      sendProgress();
      return;
    }

    if (pending) {
      await sleep(1500);
      startJob(pending.mode || "dryrun", pending);
      return;
    }

    if (verify) {
      createPanel();
      state.running = true;
      state.phase = "enumerating";
      state.cancelled = false;
      state.paused = false;
      state.haltReason = null;
      state.items = [];
      state.processed = 0;
      state.removed = 0;
      state.failed = 0;
      state.skipped = 0;
      state.status = "Đang kiểm tra lại...";
      renderPanel();
      await sleep(1500);

      const ok = await ensureFavoritesView("dryrun");
      if (!ok) {
        state.running = false;
        return;
      }

      const items = await enumerateItems();
      state.items = items;
      state.running = false;
      state.phase = "done";
      state.status = `Còn lại ${items.length} video trong Yêu thích.`;
      log(`Xác minh: còn ${items.length} video.`);
      renderPanel();
      sendProgress();
    }
  }

  // Nạp cấu hình đã lưu trước khi có lệnh chạy đầu tiên.
  loadConfig();

  handlePendingFlags();
})();