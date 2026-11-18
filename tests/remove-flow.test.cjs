"use strict";

/**
 * Test cho luồng xoá thật của content.js.
 * Kiểm tra:
 *  1. KHÔNG xoá gì khi người dùng chưa bấm "Xác nhận xoá" (an toàn).
 *  2. Bấm xác nhận → xoá đúng 3 video qua API giả.
 *  3. Nút "Dừng" giữa chừng dừng được và không xoá tiếp.
 *
 * Chạy: node tests/remove-flow.test.cjs
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const CONTENT = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

const FAVORITES_HTML = `
<!DOCTYPE html>
<html>
  <body>
    <div role="tablist">
      <div role="tab" data-e2e="favorites-tab" aria-selected="true">Favorites</div>
    </div>
    <div id="posts" aria-selected="true">Posts 3</div>
    <div data-e2e="favorites-item-list">
      <div data-e2e="favorites-item"><a href="/@alice/video/2001">Alice</a></div>
      <div data-e2e="favorites-item"><a href="/@bob/video/2002">Bob</a></div>
      <div data-e2e="favorites-item"><a href="/@carol/video/2003">Carol</a></div>
    </div>
  </body>
</html>`;

function setup(opts = {}) {
  const dom = new JSDOM(FAVORITES_HTML, {
    url: "https://www.tiktok.com/@me",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const removed = [];
  const listeners = [];
  const apiDelayMs = opts.apiDelayMs || 0;

  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
      sendMessage(msg, cb) {
        // content → background: removeViaApi
        if (msg && msg.action === "removeViaApi") {
          removed.push(msg.itemId);
          const respond = () => {
            if (typeof cb === "function") cb({ ok: true, statusCode: 0 });
          };
          if (apiDelayMs > 0) setTimeout(respond, apiDelayMs);
          else respond();
          return;
        }
        // content → popup: tfc:progress (không cần làm gì)
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
  console.error = (...a) => {
    errors.push(a.map(String).join(" "));
  };

  try {
    window.eval(CONTENT);
  } finally {
    console.error = origError;
  }

  function emit(msg) {
    let responded;
    for (const fn of listeners) fn(msg, {}, (r) => (responded = r));
    return responded;
  }

  function shadowEl(id) {
    const host = window.document.getElementById("tfc-host");
    return host && host.shadowRoot ? host.shadowRoot.getElementById(id) : null;
  }

  return { window, removed, errors, emit, shadowEl };
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

async function testNoRemovalBeforeConfirmation() {
  const ctx = setup();

  ctx.emit({
    action: "tfc:start",
    config: { mode: "remove", method: "api", delayMs: 100 },
  });

  // Chờ tới khi panel báo "Hãy xác nhận"
  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready");

  const before = ctx.emit({ action: "tfc:getStatus" });
  assert.strictEqual(before.phase, "ready", "phải ở trạng thái chờ xác nhận");
  assert.strictEqual(
    ctx.removed.length,
    0,
    "TUYỆT ĐỐI không được xoá khi chưa xác nhận, đã xoá: " + ctx.removed.join(",")
  );

  // Nút xác nhận phải hiện, các nút chạy phải ẩn
  const confirmBtn = ctx.shadowEl("tfcConfirm");
  assert.ok(confirmBtn, "nút xác nhận phải tồn tại");
  assert.strictEqual(confirmBtn.hidden, false, "nút xác nhận phải HIỆN khi chờ xác nhận");

  // Bấm Huỷ (Dừng) → không xoá gì
  const stopBtn = ctx.shadowEl("tfcStop");
  assert.ok(stopBtn, "nút Dừng phải tồn tại");
  assert.strictEqual(stopBtn.hidden, false, "nút Dừng phải hiện cả khi chờ xác nhận");
  stopBtn.click();
  await wait(300);

  assert.strictEqual(ctx.removed.length, 0, "sau khi Huỷ vẫn không được xoá");
  const after = ctx.emit({ action: "tfc:getStatus" });
  assert.strictEqual(after.phase, "idle", "huỷ → phase = idle");
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));

  console.log("  [OK] Không xoá khi chưa xác nhận; Huỷ hoạt động");
}

async function testConfirmRemovesAll() {
  const ctx = setup();

  ctx.emit({
    action: "tfc:start",
    config: { mode: "remove", method: "api", delayMs: 100 },
  });

  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready");

  const total = ctx.emit({ action: "tfc:getStatus" }).total;
  assert.strictEqual(total, 3, "phải liệt kê 3 video");

  ctx.shadowEl("tfcConfirm").click();

  // Chờ hoàn tất
  const done = await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "done" ? s : null;
  }, 30000, "phase=done");

  assert.strictEqual(done.removed, 3, "phải xoá 3 video, thực tế: " + done.removed);
  assert.strictEqual(done.failed, 0, "không lỗi, thực tế: " + done.failed);
  assert.deepStrictEqual(
    ctx.removed.slice().sort(),
    ["2001", "2002", "2003"],
    "phải gọi API đúng 3 id"
  );
  assert.match(done.status, /Hoàn tất/, "status phải là Hoàn tất, thực tế: " + done.status);
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));

  // Nút "Kiểm tra lại" phải hiện khi xong
  const verifyBtn = ctx.shadowEl("tfcVerify");
  assert.strictEqual(verifyBtn.hidden, false, "nút Kiểm tra lại phải hiện khi xong");

  console.log("  [OK] Xác nhận → xoá đủ 3 video qua API");
}

async function testStopMidway() {
  const ctx = setup();

  ctx.emit({
    action: "tfc:start",
    config: { mode: "remove", method: "api", delayMs: 1500 },
  });

  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready");

  ctx.shadowEl("tfcConfirm").click();

  // Chờ ít nhất 1 video được xoá
  await waitFor(() => ctx.removed.length >= 1, 15000, "≥1 video bị xoá");

  // Bấm Dừng
  const stopBtn = ctx.shadowEl("tfcStop");
  assert.ok(stopBtn, "nút Dừng phải tồn tại");
  stopBtn.click();

  await wait(2500);
  const stopped = ctx.emit({ action: "tfc:getStatus" });
  assert.strictEqual(stopped.running, false, "sau khi Dừng → running=false");
  assert.ok(stopped.removed < 3, "phải dừng trước khi xoá hết, đã xoá: " + stopped.removed);
  assert.match(stopped.status, /Đã dừng/, "status phải là Đã dừng, thực tế: " + stopped.status);

  const countAtStop = ctx.removed.length;
  await wait(2000);
  assert.strictEqual(
    ctx.removed.length,
    countAtStop,
    "sau khi Dừng không được xoá thêm (trước " + countAtStop + ", sau " + ctx.removed.length + ")"
  );

  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));
  console.log("  [OK] Dừng giữa chừng: dừng đúng, không xoá thêm (đã xoá " + countAtStop + ")");
}

async function testRestartAfterStop() {
  // Dừng rồi chạy lại ngay — vòng lặp cũ không được ghi đè trạng thái mới.
  const ctx = setup();

  ctx.emit({
    action: "tfc:start",
    config: { mode: "remove", method: "api", delayMs: 2000 },
  });
  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready (lần 1)");

  ctx.shadowEl("tfcConfirm").click();
  await waitFor(() => ctx.removed.length >= 1, 15000, "≥1 video (lần 1)");

  ctx.emit({ action: "tfc:stop" });
  await wait(500);

  // Chạy lại
  ctx.emit({
    action: "tfc:start",
    config: { mode: "remove", method: "api", delayMs: 100 },
  });
  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready (lần 2)");

  ctx.shadowEl("tfcConfirm").click();
  const done = await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "done" ? s : null;
  }, 30000, "phase=done (lần 2)");

  assert.strictEqual(done.removed, 3, "lần 2 phải xoá đủ 3, thực tế: " + done.removed);
  assert.match(done.status, /Hoàn tất/, "lần 2 phải kết thúc bằng Hoàn tất, thực tế: " + done.status);
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));

  console.log("  [OK] Dừng rồi chạy lại: không bị vòng lặp cũ ghi đè");
}

async function testRestartWhileApiInFlight() {
  // Dừng NGAY khi lệnh API đang bay (chưa có phản hồi) rồi chạy lại.
  // Lệnh cũ phải bị huỷ, không được ghi đè bộ đếm của lần chạy mới.
  const ctx = setup({ apiDelayMs: 1200 });

  ctx.emit({
    action: "tfc:start",
    config: { mode: "remove", method: "api", delayMs: 50 },
  });
  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready (lần 1)");

  ctx.shadowEl("tfcConfirm").click();

  // Lệnh API đầu tiên đã được gửi nhưng phản hồi chưa về (delay 1200ms).
  await waitFor(() => ctx.removed.length >= 1, 15000, "≥1 lệnh API đã gửi");

  // Dừng rồi chạy lại ngay khi lệnh cũ còn đang treo.
  ctx.emit({ action: "tfc:stop" });
  await wait(150);

  ctx.emit({
    action: "tfc:start",
    config: { mode: "remove", method: "api", delayMs: 50 },
  });
  await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "ready" ? s : null;
  }, 15000, "phase=ready (lần 2)");

  ctx.shadowEl("tfcConfirm").click();

  const done = await waitFor(() => {
    const s = ctx.emit({ action: "tfc:getStatus" });
    return s && s.phase === "done" ? s : null;
  }, 30000, "phase=done (lần 2)");

  // Chờ thêm để chắc chắn lệnh cũ (nếu còn sống) không ghi đè.
  await wait(2000);
  const final = ctx.emit({ action: "tfc:getStatus" });

  assert.strictEqual(done.removed, 3, "lần 2 phải xoá đủ 3, thực tế: " + done.removed);
  assert.match(done.status, /Hoàn tất/, "lần 2 phải kết thúc bằng Hoàn tất, thực tế: " + done.status);
  assert.strictEqual(
    final.removed,
    3,
    "lệnh cũ không được ghi đè bộ đếm (sau 2s, thực tế: " + final.removed + ")"
  );
  assert.match(final.status, /Hoàn tất/, "trạng thái cuối vẫn phải là Hoàn tất, thực tế: " + final.status);
  assert.strictEqual(ctx.errors.length, 0, "không lỗi: " + ctx.errors.join(" | "));

  console.log("  [OK] Dừng khi API đang bay rồi chạy lại: lệnh cũ bị huỷ, bộ đếm không bị ghi đè");
}

async function main() {
  console.log("REMOVE FLOW TESTS");
  await testNoRemovalBeforeConfirmation();
  await testConfirmRemovesAll();
  await testStopMidway();
  await testRestartAfterStop();
  await testRestartWhileApiInFlight();
  console.log("ALL REMOVE FLOW TESTS PASSED");
}

main().catch((e) => {
  console.error("REMOVE FLOW TEST FAILED:", e);
  process.exit(1);
});