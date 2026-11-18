"use strict";

/**
 * Test luồng khôi phục:
 *  1. tfc_autostart: điều hướng sang /profile rồi tự chạy lại (an toàn, không tự xoá).
 *  2. tfc_verify: tải lại trang rồi đếm lại số video còn lại.
 *  3. tfc_ui_resume: KHÔNG bao giờ tự động xoá, chỉ hiện thông báo.
 *
 * Chạy: node tests/recovery-flow.test.cjs
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const CONTENT = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

const HTML = `
<!DOCTYPE html>
<html>
  <body>
    <div role="tablist">
      <div role="tab" data-e2e="favorites-tab" aria-selected="true">Favorites</div>
    </div>
    <div id="posts" aria-selected="true">Posts 2</div>
    <div data-e2e="favorites-item-list">
      <div data-e2e="favorites-item"><a href="/@alice/video/5001">A</a></div>
      <div data-e2e="favorites-item"><a href="/@bob/video/5002">B</a></div>
    </div>
  </body>
</html>`;

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} opts.session  các khoá sessionStorage cần set trước khi chạy
 * @param {boolean} opts.noGrid  bỏ grid Favorites khỏi DOM (mô phỏng chưa ở đúng trang)
 */
function setup(opts = {}) {
  // Bỏ qua các "jsdomError" như "Not implemented: navigation" để output test gọn.
  const { VirtualConsole } = require("jsdom");
  const virtualConsole = new VirtualConsole();

  const dom = new JSDOM(HTML, {
    url: opts.url || "https://www.tiktok.com/@me",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const doc = window.document;

  if (opts.noGrid) {
    doc.querySelectorAll("[data-e2e='favorites-item-list']").forEach((n) => n.remove());
    const posts = doc.getElementById("posts");
    if (posts) posts.setAttribute("aria-selected", "false");
  }

  for (const [k, v] of Object.entries(opts.session || {})) {
    window.sessionStorage.setItem(k, v);
  }

  const removed = [];
  const listeners = [];

  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
      sendMessage(msg, cb) {
        if (msg && msg.action === "removeViaApi") {
          removed.push(msg.itemId);
          if (typeof cb === "function") cb({ ok: true, statusCode: 0 });
          return;
        }
        if (typeof cb === "function") cb(undefined);
      },
      getManifest: () => ({ version: "1.0.0" }),
    },
    storage: {
      local: {
        get(_k, cb) {
          cb({});
        },
        set() {},
      },
    },
  };

  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = function () {};

  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.error || e.message));
  const origError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));

  // jsdom không cho thay thế window.location (non-configurable).
  // Ta phát hiện điều hướng dựa vào cờ `tfc_autostart` mà content.js ghi trước khi chuyển trang.
  let navigatedTo = null;

  try {
    window.eval(CONTENT);
  } finally {
    console.error = origError;
  }

  const emit = (msg) => {
    let responded;
    for (const fn of listeners) fn(msg, {}, (r) => (responded = r));
    return responded;
  };
  const shadowEl = (id) => {
    const host = doc.getElementById("tfc-host");
    return host && host.shadowRoot ? host.shadowRoot.getElementById(id) : null;
  };

  return {
    window,
    doc,
    removed,
    errors,
    emit,
    shadowEl,
    // Điều hướng = content.js đã ghi cờ tfc_autostart (không thể thay location trong jsdom).
    getNavigatedTo: () => {
      try {
        return window.sessionStorage.getItem("tfc_autostart");
      } catch (_) {
        return null;
      }
    },
    session: window.sessionStorage,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await wait(100);
  }
  throw new Error("Timeout chờ: " + (label || "condition"));
}

async function testAutostartAfterNavigation() {
  // Giả lập: người dùng bấm Xoá tất cả ở trang khác → code đã set tfc_autostart.
  const ctx = setup({
    session: {
      tfc_autostart: JSON.stringify({ mode: "remove", method: "api", delayMs: 100 }),
    },
  });

  // Chờ tới khi tự khởi động xong (phase = ready, chờ xác nhận)
  const ready = await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 20000, "phase=ready sau autostart");

  assert.strictEqual(ready.total, 2, "phải liệt kê 2 video, thực tế: " + ready.total);
  assert.strictEqual(
    ctx.removed.length,
    0,
    "autostart KHÔNG được tự xoá khi chưa xác nhận"
  );
  assert.strictEqual(
    ctx.session.getItem("tfc_autostart"),
    null,
    "cờ tfc_autostart phải được xoá sau khi dùng"
  );
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));
  console.log("  [OK] Autostart sau điều hướng: tự liệt kê, chờ xác nhận, không tự xoá");
}

async function testVerifyFlow() {
  // Giả lập: người dùng bấm "Kiểm tra lại" → set tfc_verify rồi tải lại trang.
  const ctx = setup({
    session: { tfc_verify: "1" },
  });

  const done = await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "done" ? s : null;
  }, 20000, "phase=done sau verify");

  assert.match(done.status, /Còn lại 2 video/, "phải báo còn 2 video, thực tế: " + done.status);
  assert.strictEqual(done.removed, 0, "kiểm tra lại không xoá gì");
  assert.strictEqual(ctx.session.getItem("tfc_verify"), null, "cờ tfc_verify phải được xoá");
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));
  console.log("  [OK] Kiểm tra lại: đếm lại đúng, không xoá gì");
}

async function testUiResumeNeverAutoDeletes() {
  // Giả lập: lần trước bấm bookmark gây tải lại trang.
  const ctx = setup({
    session: {
      tfc_ui_resume: JSON.stringify({ at: Date.now() }),
    },
  });

  // Chờ panel hiện + status báo
  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && /tải lại/.test(s.status) ? s : null;
  }, 15000, "status báo tải lại");

  const s = ctx.emit({ action: "tfc:getStatus" });
  assert.match(s.status, /Trang đã tải lại/, "phải báo trang đã tải lại, thực tế: " + s.status);
  assert.strictEqual(ctx.removed.length, 0, "TUYỆT ĐỐI không tự xoá sau khi khôi phục");
  assert.strictEqual(s.running, false, "không được chạy nền");
  assert.strictEqual(
    ctx.session.getItem("tfc_ui_resume"),
    null,
    "cờ tfc_ui_resume phải được xoá"
  );

  // Nút "Xoá tất cả" phải khả dụng để người dùng tự quyết định
  const startBtn = ctx.shadowEl("tfcStart");
  assert.ok(startBtn, "nút Xoá tất cả phải tồn tại");
  assert.strictEqual(startBtn.hidden, false, "nút Xoá tất cả phải hiện");

  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));
  console.log("  [OK] Khôi phục sau tải lại: chỉ báo, không tự xoá");
}

async function testUiResumeIgnoredWhenStale() {
  // Cờ quá cũ (> 5 phút) → bỏ qua, không làm gì.
  const ctx = setup({
    session: {
      tfc_ui_resume: JSON.stringify({ at: Date.now() - 10 * 60 * 1000 }),
    },
  });

  await wait(2000);
  const s = ctx.emit({ action: "tfc:getStatus" });
  assert.doesNotMatch(s.status, /tải lại/, "cờ cũ phải bị bỏ qua, thực tế: " + s.status);
  assert.strictEqual(ctx.removed.length, 0, "không xoá gì");
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));
  console.log("  [OK] Cờ khôi phục quá cũ → bỏ qua");
}

async function testNavigateWhenNotOnFavorites() {
  // Không có grid + không có tab Favorites → code phải ghi cờ tfc_autostart để tự chạy lại.
  const ctx = setup({ noGrid: true });

  ctx.emit({
    action: "tfc:start",
    config: { mode: "dryrun", method: "api", delayMs: 100 },
  });

  await waitFor(() => ctx.getNavigatedTo(), 15000, "ghi cờ tfc_autostart");

  const raw = ctx.getNavigatedTo();
  let flag = null;
  try {
    flag = JSON.parse(raw);
  } catch (_) {
    flag = null;
  }
  assert.ok(flag && typeof flag === "object", "tfc_autostart phải là JSON hợp lệ, thực tế: " + raw);
  assert.strictEqual(flag.mode, "dryrun", "phải giữ đúng chế độ dryrun, thực tế: " + flag.mode);
  assert.strictEqual(flag.method, "api", "phải giữ đúng cơ chế api, thực tế: " + flag.method);
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));
  console.log("  [OK] Không ở Favorites → ghi cờ tự chạy lại (tfc_autostart) đúng chế độ");
}

async function main() {
  console.log("RECOVERY FLOW TESTS");
  await testAutostartAfterNavigation();
  await testVerifyFlow();
  await testUiResumeNeverAutoDeletes();
  await testUiResumeIgnoredWhenStale();
  await testNavigateWhenNotOnFavorites();
  console.log("ALL RECOVERY FLOW TESTS PASSED");
}

main().catch((e) => {
  console.error("RECOVERY FLOW TEST FAILED:", e);
  process.exit(1);
});