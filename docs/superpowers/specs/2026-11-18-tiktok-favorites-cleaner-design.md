# Thiết kế: TikTok Favorites Cleaner (Chrome Extension)

Ngày: 2026-11-18
Thư mục: `D:\tiktok remove`

## 1. Mục tiêu

Một tiện ích Chrome (Manifest V3) chạy trên `tiktok.com` giúp người dùng **xoá toàn bộ video khỏi mục Yêu thích (Favorites → Posts)** một cách tự động, thay vì phải mở từng video và bấm nút bookmark vàng bằng tay.

Yêu cầu cụ thể từ người dùng:

- Mở từng video trong Favorites → bấm icon bookmark (vàng) để bỏ yêu thích → chuyển video kế tiếp.
- Phạm vi: **tất cả** video trong Yêu thích.
- Có **xác nhận** trước khi xoá + chế độ **chạy thử (dry-run)** chỉ liệt kê, không xoá.
- Có **Dừng / Tạm dừng**.
- Tốc độ **nhanh** (mặc định 0.7s giữa mỗi video).
- "Làm cả 2 cách": triển khai **2 cơ chế xoá** (API + UI).

## 2. Non-goals / Anti-goals

- Không xoá video trong các mục khác (Liked, Reposts, Collections riêng lẻ).
- Không tải video, không đọc bình luận, không gửi dữ liệu ra máy chủ ngoài.
- Không tự động đăng nhập, không vượt captcha.
- Không "xoá tất cả" khi chưa có xác nhận của người dùng.

## 3. Hai cơ chế xoá

### 3.1 Cơ chế A — API nhanh (mặc định)

Gọi đúng endpoint mà chính TikTok Web dùng khi bỏ yêu thích:

```
POST https://www.tiktok.com/api/item/collect/?aid=1988&action=2&itemId=<id>&secUid=<secUid>
Headers: tt-csrf-token: <csrfToken>, content-type: application/x-www-form-urlencoded
Credentials: same-origin (kèm cookie đăng nhập)
```

- `secUid` và `csrfToken` đọc từ `window.__$UNIVERSAL_DATA$__` (hoặc `#__UNIVERSAL_DATA_FOR_REHYDRATION__`) → `__DEFAULT_SCOPE__["webapp.app-context"]`.
- Endpoint được gọi trong **MAIN world** (qua `chrome.scripting.executeScript`) để có cookie + context thật của trang.
- Ưu: cực nhanh, không cần mở từng video.
- Nhược: phụ thuộc endpoint nội bộ (có thể đổi). → Có cơ chế B làm dự phòng.

### 3.2 Cơ chế B — Giao diện (UI) / dự phòng

Mô phỏng đúng thao tác tay: mở video → tìm nút bookmark → kiểm tra đang "đã lưu" → bấm → xác minh chuyển sang "chưa lưu" → đóng modal.

- Selector dự phòng nhiều lớp:
  - `button` chứa `[data-e2e="bookmark-icon"]` / `[data-e2e="collect-icon"]` / `[data-e2e="favorites-icon"]` / `[data-e2e="browse-bookmark"]`.
  - Fallback theo `aria-label` chứa "favorite/bookmark/收藏".
- Ưu: bền khi backend đổi, dễ xác minh bằng mắt.
- Nhược: chậm hơn (phải mở từng video).

### 3.3 Chế độ "Tự động" (auto)

- Thử API trước. Nếu API lỗi (network/HTTP/session) → tự động chuyển sang UI cho video đó.
- Người dùng có thể chọn cứng `api` hoặc `ui` trong popup.

## 4. Luồng hoạt động

1. Người dùng mở `tiktok.com`, đăng nhập, vào **Profile → Favorites → Posts**.
2. Bấm icon extension → chọn "Chạy thử" hoặc "Xoá tất cả".
3. Content script:
   - Đảm bảo đang ở đúng view Favorites (tự click tab nếu cần; nếu chưa ở profile thì điều hướng + tự chạy lại sau khi tải).
   - **Liệt kê**: cuộn grid để tải hết, thu thập `itemId`, `authorName`, `url`, `desc`.
   - **Dry-run**: chỉ báo "Tìm thấy N video", không thay đổi gì.
   - **Remove**: hiện panel xác nhận "Sẽ xoá N video" → người dùng bấm **Xác nhận xoá**.
   - Lặp qua từng item: gọi cơ chế đã chọn, ghi log, cập nhật tiến độ, chờ `delayMs`.
   - Nếu gặp `RATE_LIMITED` (429) hoặc `SESSION_REJECTED` (401/403) → dừng ngay, báo người dùng chờ ~1 giờ.
   - Kết thúc: tổng kết `đã xoá / lỗi / bỏ qua`, gợi ý tải lại trang để xác nhận.
4. Có thể bấm **Dừng** hoặc **Tạm dừng** bất cứ lúc nào.

## 5. Kiến trúc file

```
manifest.json          # MV3, quyền storage/scripting/tabs, host tiktok.com
background.js          # service worker: removeViaApi (inject MAIN world)
content.js             # toàn bộ logic: liệt kê, UI, panel, vòng lặp
popup.html/css/js      # điều khiển: chạy thử / xoá / tuỳ chọn tốc độ + cơ chế
icons/icon16|48|128.png
README.md              # hướng dẫn cài đặt & sử dụng
```

Giao tiếp:
- Popup → Content: `chrome.tabs.sendMessage(tabId, {action:'tfc:start', config})`.
- Content → Popup: `chrome.runtime.sendMessage({action:'tfc:progress', state})`.
- Content → Background: `chrome.runtime.sendMessage({action:'removeViaApi', itemId})`.
- Panel (trong trang) dùng **Shadow DOM** để không đụng CSS của TikTok.

## 6. Chi tiết kỹ thuật quan trọng

### 6.1 Liệt kê video

- Selector chính: `[data-e2e="favorites-item"] a[href*="/video/"]` (fallback `favorites-item-list`, `#posts`).
- Regex lấy id: `/@([^/]+)/(?:video|photo)/(\d+)`.
- Cuộn tới khi: số item không tăng + chiều cao trang không đổi qua 6 chu kỳ, HOẶC đạt số đếm kỳ vọng ở `#posts`.

### 6.2 Xác minh

- API: coi `status_code === 0` (hoặc body rỗng) là thành công.
- UI: so sánh `aria-label`/trạng thái icon trước và sau khi bấm; nếu đổi sang "Add to Favorites" → thành công.
- Cuối run: đếm lại số item còn trong grid (sau khi tải lại) để báo "còn lại".

### 6.3 An toàn

- Không bao giờ xoá khi chưa có `confirmOpen = true`.
- Nút Dừng/Tạm dừng luôn khả dụng trong lúc chạy.
- Lưu cấu hình vào `chrome.storage.local`.
- Không có analytics, không gửi dữ liệu ra ngoài.

## 7. Cách cài đặt (tham khảo README)

1. Giải nén vào một thư mục.
2. Mở `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục.
3. Mở `tiktok.com`, đăng nhập, vào Favorites.
4. Bấm icon extension → **Chạy thử** trước, sau đó **Xoá tất cả**.

## 8. Rủi ro & giảm thiểu

| Rủi ro | Giảm thiểu |
|---|---|
| TikTok đổi endpoint | Cơ chế UI dự phòng + selector nhiều lớp |
| Bị rate limit | Dừng khi 429, khuyến nghị chờ 1 giờ |
| Xoá nhầm | Bắt buộc dry-run + xác nhận |
| DOM Favorites đổi | Nhiều selector dự phòng, đếm kỳ vọng từ `#posts` |
| Mất mạng giữa chừng | Tự thử lại 3 lần (backoff) cho lỗi mạng/timeout/5xx |
| TikTok đổi giao diện/API | Tự dừng sau 5 lỗi liên tiếp, báo rõ lý do |
| Bấm Dừng rồi chạy lại ngay | Dùng `runId` để vòng lặp cũ không ghi đè trạng thái mới |
| Bấm card gây tải lại trang | Ghi `tfc_ui_resume`, lần sau chỉ nhắc lại — **không tự xoá** |
| Xoá khi chưa xác nhận | Chốt `confirmOpen` trong handler nút Xác nhận |

## 9. Kiểm thử

Bộ test chạy `content.js`/`background.js` trong DOM giả (jsdom) + `chrome` API giả:

```
tests/background.test.cjs     # 12 test: endpoint, action=2, header, 429/401/403/5xx, NO_SESSION
tests/smoke-content.test.cjs  # panel Shadow DOM, dry-run, getStatus
tests/remove-flow.test.cjs    # không xoá khi chưa xác nhận, xoá đủ, Dừng, chạy lại
tests/ui-flow.test.cjs        # cơ chế UI, auto fallback, 5 lỗi liên tiếp
tests/recovery-flow.test.cjs  # tự chạy lại sau điều hướng, Kiểm tra lại, không tự xoá
```

Chạy: `npm install && npm test` (hoặc `node tests/run-all.cjs`).