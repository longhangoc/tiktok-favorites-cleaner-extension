"use strict";

/**
 * Chạy toàn bộ test. Không cần jsdom cho background.test.cjs,
 * nhưng 3 test DOM cần jsdom → tự kiểm tra và hướng dẫn nếu thiếu.
 *
 * Chạy: node tests/run-all.cjs
 */

const { execFileSync } = require("child_process");
const path = require("path");

const files = [
  "background.test.cjs",
  "smoke-content.test.cjs",
  "remove-flow.test.cjs",
  "ui-flow.test.cjs",
  "recovery-flow.test.cjs",
];

let failed = 0;

for (const f of files) {
  const full = path.join(__dirname, f);
  console.log("");
  console.log("=== " + f + " ===");
  try {
    const out = execFileSync(process.execPath, [full], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 300000,
    });
    process.stdout.write(out);
  } catch (e) {
    failed++;
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    console.error("FAILED: " + f);
  }
}

console.log("");
if (failed > 0) {
  console.error("TỔNG KẾT: " + failed + " file test thất bại.");
  process.exit(1);
}
console.log("TỔNG KẾT: tất cả test đều qua.");