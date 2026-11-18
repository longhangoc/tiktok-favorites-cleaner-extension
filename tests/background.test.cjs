"use strict";

/**
 * Test background.js — phần removeFavoriteMain chạy trong MAIN world.
 * Dùng vm để chạy hàm trong context giả có window/document/fetch.
 *
 * Chạy: node tests/background.test.cjs
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const CODE = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

function makeContext(opts = {}) {
  const calls = [];
  const context = {
    console,
    URLSearchParams,
    Number,
    String,
    JSON,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: opts.httpOk !== false,
        status: opts.status || 200,
        text: async () => opts.body !== undefined ? opts.body : JSON.stringify({ status_code: 0 }),
      };
    },
  };

  const universal = {
    __DEFAULT_SCOPE__: {
      "webapp.app-context": {
        user: { secUid: opts.secUid === undefined ? "sec-abc" : opts.secUid },
        csrfToken: opts.csrfToken === undefined ? "csrf-xyz" : opts.csrfToken,
      },
    },
  };

  context.window = {
    __$UNIVERSAL_DATA$__: universal,
    addEventListener() {},
    removeEventListener() {},
  };
  context.document = {
    getElementById() {
      return null;
    },
  };

  context.chrome = {
    runtime: {
      onMessage: {
        addListener() {},
      },
    },
    scripting: {
      executeScript() {},
    },
  };

  return { context, calls };
}

async function runRemove(itemId, opts) {
  const { context, calls } = makeContext(opts);
  vm.createContext(context);
  vm.runInContext(CODE, context);
  const result = await context.removeFavoriteMain(itemId);
  return { result, calls };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("gọi đúng endpoint /api/item/collect/ với action=2 (unfavorite)", async () => {
  const { result, calls } = await runRemove("1234567890");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.strictEqual(u.pathname, "/api/item/collect/");
  assert.strictEqual(u.searchParams.get("action"), "2");
  assert.strictEqual(u.searchParams.get("itemId"), "1234567890");
  assert.strictEqual(u.searchParams.get("secUid"), "sec-abc");
  assert.strictEqual(u.searchParams.get("aid"), "1988");
});

test("gửi credentials same-origin + header tt-csrf-token", async () => {
  const { calls } = await runRemove("1");
  assert.strictEqual(calls[0].options.credentials, "same-origin");
  assert.strictEqual(calls[0].options.method, "POST");
  assert.strictEqual(calls[0].options.headers["tt-csrf-token"], "csrf-xyz");
});

test("thiếu secUid → NO_SESSION, không gọi fetch", async () => {
  const { result, calls } = await runRemove("1", { secUid: "" });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, "NO_SESSION");
  assert.strictEqual(calls.length, 0);
});

test("HTTP 429 → RATE_LIMITED", async () => {
  const { result } = await runRemove("1", { httpOk: false, status: 429, body: "rate" });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, "RATE_LIMITED");
  assert.strictEqual(result.httpStatus, 429);
});

test("HTTP 401 → SESSION_REJECTED", async () => {
  const { result } = await runRemove("1", { httpOk: false, status: 401, body: "no" });
  assert.strictEqual(result.errorCode, "SESSION_REJECTED");
});

test("HTTP 403 → SESSION_REJECTED", async () => {
  const { result } = await runRemove("1", { httpOk: false, status: 403, body: "no" });
  assert.strictEqual(result.errorCode, "SESSION_REJECTED");
});

test("HTTP 500 → HTTP_ERROR", async () => {
  const { result } = await runRemove("1", { httpOk: false, status: 500, body: "boom" });
  assert.strictEqual(result.errorCode, "HTTP_ERROR");
  assert.strictEqual(result.httpStatus, 500);
});

test("status_code != 0 → TIKTOK_REJECTED", async () => {
  const { result } = await runRemove("1", {
    body: JSON.stringify({ status_code: 10221, status_msg: "not found" }),
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, "TIKTOK_REJECTED");
  assert.strictEqual(result.statusCode, 10221);
});

test("fetch ném lỗi → NETWORK_ERROR", async () => {
  const { context } = makeContext();
  context.fetch = async () => {
    throw new Error("connection reset");
  };
  vm.createContext(context);
  vm.runInContext(CODE, context);
  const result = await context.removeFavoriteMain("1");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, "NETWORK_ERROR");
  assert.match(result.error, /connection reset/);
});

test("đọc context từ #__UNIVERSAL_DATA_FOR_REHYDRATION__ khi window thiếu", async () => {
  const { context } = makeContext();
  delete context.window.__$UNIVERSAL_DATA$__;
  context.document.getElementById = (id) => {
    if (id !== "__UNIVERSAL_DATA_FOR_REHYDRATION__") return null;
    return {
      textContent: JSON.stringify({
        __DEFAULT_SCOPE__: {
          "webapp.app-context": {
            user: { secUid: "sec-from-script" },
            csrfToken: "csrf-from-script",
          },
        },
      }),
    };
  };
  vm.createContext(context);
  vm.runInContext(CODE, context);
  const result = await context.removeFavoriteMain("1");
  assert.strictEqual(result.ok, true);
});

test("JSON body không hợp lệ vẫn coi là thành công (một số phản hồi rỗng)", async () => {
  const { result } = await runRemove("1", { body: "" });
  assert.strictEqual(result.ok, true);
});

test("body HTML (không phải JSON) → vẫn ok nếu HTTP 200", async () => {
  const { result } = await runRemove("1", { body: "<html>ok</html>" });
  assert.strictEqual(result.ok, true);
});

// Chạy tuần tự
(async () => {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  [OK] " + t.name);
      pass++;
    } catch (e) {
      console.error("  [FAIL] " + t.name);
      console.error("        " + (e && e.message));
      fail++;
    }
  }
  console.log("");
  console.log("BACKGROUND TESTS: " + pass + " passed, " + fail + " failed");
  if (fail > 0) process.exit(1);
})();