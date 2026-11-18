"use strict";

/**
 * Smoke test cho content.js — chạy trong DOM giả (jsdom) + chrome API giả.
 * Mục tiêu: bắt lỗi runtime (undefined function, null ref, sai chính tả).
 * Không cần Chrome thật.
 *
 * Chạy: node tests/smoke-content.test.cjs
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
    <div id="app">
      <div role="tablist">
        <div role="tab" data-e2e="favorites-tab" aria-selected="true">Favorites</div>
      </div>
      <div id="posts" aria-selected="true">Posts 3</div>
      <div data-e2e="favorites-item-list">
        <div data-e2e="favorites-item">
          <a href="/@alice/video/1001">Alice</a>
        </div>
        <div data-e2e="favorites-item">
          <a href="/@bob/video/1002">Bob</a>
        </div>
        <div data-e2e="favorites-item">
          <a href="/@carol/photo/1003">Carol</a>
        </div>
      </div>
    </div>
  </body>
</html>`;

function makeChromeStub() {
  const listeners = [];
  const sent = [];

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
      sendMessage(msg, cb) {
        sent.push(msg);
        if (typeof cb === "function") cb({ ok: true });
      },
      getManifest: () => ({ version: "1.0.0" }),
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({});
        },
        set() {},
      },
    },
  };

  return {
    chrome,
    listeners,
    sent,
    emit(msg) {
      // mô phỏng chrome calling content listener
      let responded = null;
      for (const fn of listeners) {
        const keep = fn(msg, {}, (r) => {
          responded = r;
        });
        if (keep === true) {
          // async listener — bỏ qua
        }
      }
      return responded;
    },
  };
}

async function main() {
  const dom = new JSDOM(FAVORITES_HTML, {
    url: "https://www.tiktok.com/@me",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });

  const { window } = dom;
  const stub = makeChromeStub();

  // Cung cấp chrome + stubs mà content.js cần.
  window.chrome = stub.chrome;

  // Element.prototype.scrollTo không tồn tại trong jsdom
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = function () {};

  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.error || e.message));
  const origError = console.error;
  console.error = (...a) => {
    errors.push(a.map(String).join(" "));
    origError.apply(console, a);
  };

  // Chạy content.js
  try {
    window.eval(CONTENT);
  } catch (e) {
    console.error = origError;
    console.error("FAIL: content.js ném lỗi khi tải:", e);
    process.exit(1);
  }

  // Cho các timer chạy một chút
  await new Promise((r) => setTimeout(r, 300));

  console.error = origError;

  // 1) Panel phải được tạo (handlePendingFlags không có cờ → không tạo panel).
  //    Nhưng loadConfig chạy được, không ném lỗi.
  assert.strictEqual(errors.length, 0, "Không được có lỗi runtime: " + errors.join(" | "));

  // 2) Gọi getStatus qua listener giả lập
  const status = stub.emit({ action: "tfc:getStatus" });
  assert.ok(status && typeof status === "object", "getStatus phải trả về object");
  assert.strictEqual(status.phase, "idle", "phase ban đầu = idle");
  assert.strictEqual(status.running, false, "running ban đầu = false");

  // 3) Lệnh rác không được ném lỗi
  assert.doesNotThrow(() => stub.emit({ action: "tfc:unknown" }));
  assert.doesNotThrow(() => stub.emit(null));
  assert.doesNotThrow(() => stub.emit({}));

  // 4) Panel được tạo khi bắt đầu dryrun — nhưng startJob cần DOM grid.
  //    Gọi start (dryrun) rồi chờ.
  const startResp = stub.emit({
    action: "tfc:start",
    config: { mode: "dryrun", method: "api", delayMs: 300 },
  });
  assert.ok(startResp && startResp.ok, "start phải trả về ok");

  // chờ enumerate (3 items, có sleep 700ms mỗi vòng → tối đa vài giây)
  await new Promise((r) => setTimeout(r, 4000));

  assert.strictEqual(errors.length, 0, "Không được có lỗi sau khi chạy: " + errors.join(" | "));

  const after = stub.emit({ action: "tfc:getStatus" });
  assert.ok(after, "getStatus sau khi chạy phải trả về object");
  assert.strictEqual(after.phase, "done", "dryrun xong → phase = done, thực tế: " + after.phase);
  assert.strictEqual(after.total, 3, "phải tìm thấy 3 video, thực tế: " + after.total);
  assert.ok(
    /Chạy thử/.test(after.status),
    "status phải nói là chạy thử, thực tế: " + after.status
  );

  // 5) Panel phải có trong DOM và các nút
  const host = window.document.getElementById("tfc-host");
  assert.ok(host, "panel #tfc-host phải tồn tại");
  const shadow = host.shadowRoot;
  assert.ok(shadow, "shadow root phải tồn tại");
  assert.ok(shadow.getElementById("tfcStart"), "nút Xoá tất cả phải tồn tại");
  assert.ok(shadow.getElementById("tfcDryrun"), "nút Chạy thử phải tồn tại");
  assert.ok(shadow.getElementById("tfcConfirm"), "nút Xác nhận phải tồn tại");

  // 6) Bấm Dừng không ném lỗi
  assert.doesNotThrow(() => stub.emit({ action: "tfc:stop" }));
  const stopped = stub.emit({ action: "tfc:getStatus" });
  assert.strictEqual(stopped.phase, "idle", "sau khi dừng → phase = idle");
  assert.strictEqual(stopped.running, false, "sau khi dừng → running = false");

  assert.strictEqual(errors.length, 0, "Không được có lỗi ở bước cuối: " + errors.join(" | "));

  console.log("SMOKE TEST PASSED");
  console.log("  - phase sau dryrun:", after.phase);
  console.log("  - tổng video:", after.total);
  console.log("  - status:", after.status);
  console.log("  - panel + shadow DOM: OK");
}

main().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});