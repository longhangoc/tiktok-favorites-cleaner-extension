"use strict";

/**
 * Test cơ chế UI (bấm nút bookmark) + chế độ auto (API lỗi → chuyển UI).
 *
 * Mô phỏng: mỗi lần bấm card thì "modal" hiện ra với nút bookmark
 * (aria-label "Remove from Favorites"), bấm nút → đổi thành "Add to Favorites".
 * Modal đóng bằng nút aria-label="exit".
 *
 * Chạy: node tests/ui-flow.test.cjs
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
      <div data-e2e="favorites-item" id="card-3001"><a href="/@alice/video/3001">Alice</a></div>
      <div data-e2e="favorites-item" id="card-3002"><a href="/@bob/video/3002">Bob</a></div>
    </div>

    <!-- Modal giả -->
    <div id="modal" hidden>
      <button aria-label="exit">x</button>
      <button id="bm" aria-label="Remove from Favorites">Remove</button>
    </div>
  </body>
</html>`;

function setup(opts = {}) {
  const dom = new JSDOM(HTML, {
    url: "https://www.tiktok.com/@me",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const doc = window.document;

  const removed = [];
  const listeners = [];
  let apiShouldFail = !!opts.apiFails;
  const apiCalls = [];

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
          apiCalls.push(msg.itemId);
          if (apiShouldFail) {
            if (typeof cb === "function") cb({ ok: false, errorCode: "NETWORK_ERROR" });
          } else {
            removed.push(msg.itemId);
            if (typeof cb === "function") cb({ ok: true, statusCode: 0 });
          }
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

  // Mô phỏng TikTok: bấm card → mở modal
  const modal = doc.getElementById("modal");
  const bm = doc.getElementById("bm");
  const cards = doc.querySelectorAll("[data-e2e='favorites-item']");
  cards.forEach((card) => {
    card.addEventListener("click", () => {
      bm.setAttribute("aria-label", "Remove from Favorites");
      modal.hidden = false;
    });
  });

  // Bấm nút bookmark → đổi trạng thái
  bm.addEventListener("click", () => {
    if (bm.getAttribute("aria-label") === "Remove from Favorites") {
      bm.setAttribute("aria-label", "Add to Favorites");
    } else {
      bm.setAttribute("aria-label", "Remove from Favorites");
    }
  });

  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.error || e.message));
  const origError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));

  window.eval(CONTENT);
  console.error = origError;

  function emit(msg) {
    let responded;
    for (const fn of listeners) fn(msg, {}, (r) => (responded = r));
    return responded;
  }
  function shadowEl(id) {
    const host = doc.getElementById("tfc-host");
    return host && host.shadowRoot ? host.shadowRoot.getElementById(id) : null;
  }

  return { window, doc, removed, errors, emit, shadowEl, apiCalls, modal, bm };
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

async function testUiOnly() {
  const ctx = setup();
  ctx.emit({ action: "tfc:start", config: { mode: "remove", method: "ui", delayMs: 100 } });

  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready");

  assert.strictEqual(ctx.emit({ action: "tfc:getStatus" }).total, 2, "phải thấy 2 video");

  ctx.shadowEl("tfcConfirm").click();
  const done = await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "done" ? s : null;
  }, 30000, "phase=done");

  assert.strictEqual(done.removed, 2, "UI phải xoá 2 video, thực tế: " + done.removed);
  assert.strictEqual(done.failed, 0, "không lỗi, thực tế: " + done.failed);
  assert.strictEqual(ctx.apiCalls.length, 0, "chế độ ui không được gọi API");
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));
  console.log("  [OK] Cơ chế UI: bấm bookmark xoá đủ 2 video, không gọi API");
}

async function testAutoFallbackToUi() {
  const ctx = setup({ apiFails: true });
  ctx.emit({ action: "tfc:start", config: { mode: "remove", method: "auto", delayMs: 100 } });

  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready");

  ctx.shadowEl("tfcConfirm").click();
  const done = await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "done" ? s : null;
  }, 60000, "phase=done");

  // auto: API lỗi → chuyển UI → vẫn xoá được
  assert.strictEqual(done.removed, 2, "auto phải xoá 2 video qua UI, thực tế: " + done.removed);
  assert.strictEqual(done.failed, 0, "không lỗi, thực tế: " + done.failed);
  assert.ok(ctx.apiCalls.length > 0, "auto phải có gọi API trước");
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));
  console.log(
    "  [OK] Auto: API lỗi → tự chuyển UI, vẫn xoá đủ 2 (số lần gọi API: " +
      ctx.apiCalls.length +
      ")"
  );
}

async function testUiMissingCard() {
  // Xoá card khỏi DOM sau khi liệt kê → UI phải báo CARD_NOT_FOUND chứ không treo.
  const ctx = setup();
  ctx.emit({ action: "tfc:start", config: { mode: "remove", method: "ui", delayMs: 100 } });

  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready");

  // Xoá hết card khỏi DOM
  ctx.doc.querySelectorAll("[data-e2e='favorites-item']").forEach((c) => c.remove());

  ctx.shadowEl("tfcConfirm").click();
  const done = await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "done" ? s : null;
  }, 30000, "phase=done");

  assert.strictEqual(done.removed, 0, "không xoá được video nào");
  assert.strictEqual(done.failed, 2, "phải ghi nhận 2 lỗi, thực tế: " + done.failed);
  assert.match(
    done.status,
    /Hoàn tất: đã xoá 0, lỗi 2/,
    "2 lỗi (<5) thì chạy hết rồi kết thúc, thực tế: " + done.status
  );
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));
  console.log("  [OK] UI thiếu card → báo lỗi từng video, không treo, kết thúc bình thường");
}

async function testTooManyConsecutiveFailures() {
  // 7 video, không card nào tồn tại → 5 lỗi liên tiếp thì phải tự dừng.
  const html = `
  <!DOCTYPE html>
  <html><body>
    <div role="tablist"><div role="tab" data-e2e="favorites-tab" aria-selected="true">Favorites</div></div>
    <div id="posts" aria-selected="true">Posts 7</div>
    <div data-e2e="favorites-item-list">
      ${[4001, 4002, 4003, 4004, 4005, 4006, 4007]
        .map(
          (id) =>
            `<div data-e2e="favorites-item"><a href="/@u/video/${id}">${id}</a></div>`
        )
        .join("\n      ")}
    </div>
  </body></html>`;

  const dom = new JSDOM(html, {
    url: "https://www.tiktok.com/@me",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const doc = window.document;
  const listeners = [];

  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
      sendMessage(_m, cb) {
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
  window.eval(CONTENT);
  console.error = origError;

  const emit = (msg) => {
    let responded;
    for (const fn of listeners) fn(msg, {}, (r) => (responded = r));
    return responded;
  };
  const shadowEl = (id) => {
    const host = doc.getElementById("tfc-host");
    return host && host.shadowRoot ? host.shadowRoot.getElementById(id) : null;
  };

  emit({ action: "tfc:start", config: { mode: "remove", method: "ui", delayMs: 50 } });
  await waitFor(() => {
    const s = emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready");

  assert.strictEqual(emit({ action: "tfc:getStatus" }).total, 7, "phải thấy 7 video");

  // Xoá hết card → mọi lần xoá đều thất bại
  doc.querySelectorAll("[data-e2e='favorites-item']").forEach((c) => c.remove());

  shadowEl("tfcConfirm").click();
  const done = await waitFor(() => {
    const s = emit({ action: "tfc:getStatus" });
    return s && s.phase === "done" ? s : null;
  }, 60000, "phase=done");

  assert.strictEqual(done.failed, 5, "phải dừng đúng ở 5 lỗi liên tiếp, thực tế: " + done.failed);
  assert.match(
    done.status,
    /Tạm dừng sau 5 lỗi liên tiếp/,
    "status phải báo dừng vì quá nhiều lỗi, thực tế: " + done.status
  );
  assert.strictEqual(errors.length, 0, "không lỗi: " + errors.join(" | "));
  console.log("  [OK] 7 video lỗi liên tục → tự dừng đúng ở 5 lỗi, không chạy vô ích");
}

async function main() {
  console.log("UI FLOW TESTS");
  await testUiOnly();
  await testAutoFallbackToUi();
  await testUiMissingCard();
  await testTooManyConsecutiveFailures();
  console.log("ALL UI FLOW TESTS PASSED");
}

main().catch((e) => {
  console.error("UI FLOW TEST FAILED:", e);
  process.exit(1);
});