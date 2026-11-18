# sync-jira-multica

Script đồng bộ **một chiều** issue từ một project Jira sang Multica. Jira chỉ được đọc, Multica được tạo và cập nhật issue.

File chính: `sync-jira-to-multica.mjs` (Node, không cần cài thư viện).

## Script làm gì

| Đồng bộ | Cách xử lý |
|---|---|
| Title | Thêm tiền tố `[KEY-123]`, ví dụ `[ABC-12] Tên issue` |
| Description | Đổi từ định dạng ADF của Jira sang text. Có dòng link về Jira ở đầu. Link được giữ dạng Markdown |
| Status | Theo status category của Jira: To Do → `todo`, In Progress → `in_progress`, Done → `done`. Đổi được bằng `STATUS_MAP` |
| Priority | Highest → `urgent`, High → `high`, Medium → `medium`, Low/Lowest → `low`, còn lại → `none` |
| Due date | Giữ nguyên |
| Project (Multica) | Nếu đặt `MULTICA_PROJECT_ID` |
| Sprint | Chỉ khi dùng `--sprint-labels`, dưới dạng label |
| Comment | Chỉ khi dùng `--comments` |

**Không đồng bộ:** assignee, label của Jira, Epic và sub-task (quan hệ cha con), issue link, ảnh và file đính kèm, định dạng đậm/nghiêng/bảng, thứ tự rank của backlog.

## Yêu cầu

- Node **20.12 trở lên** (script tự đọc file `.env` bằng `process.loadEnvFile()`).
- Tài khoản Jira Cloud có quyền đọc project, kèm API token.
- Tài khoản Multica kèm personal access token.

## Cài đặt

1. Copy file mẫu rồi điền giá trị:
   ```bash
   cp .env.example .env
   ```
2. Điền các biến trong `.env`. Mỗi biến có chú thích trong `.env.example`.

| Biến | Bắt buộc | Lấy ở đâu |
|---|---|---|
| `JIRA_BASE_URL` | Có | Địa chỉ site Jira, ví dụ `https://your-site.atlassian.net` |
| `JIRA_EMAIL` | Có | Email tài khoản Atlassian |
| `JIRA_API_TOKEN` | Có | Tài khoản Atlassian → Security → API tokens. Nên dùng tài khoản chỉ đọc |
| `JIRA_PROJECT_KEY` | Có (trừ khi dùng `JIRA_JQL` hoặc `--issue`) | Key project, ví dụ `ABC` |
| `MULTICA_API_URL` | Có | Cloud: `https://api.multica.ai`. Self-host: địa chỉ API của bạn |
| `MULTICA_TOKEN` | Có | Multica → Settings → API Token (bắt đầu bằng `mul_`) |
| `MULTICA_WORKSPACE_SLUG` | Có (hoặc dùng ID) | Phần `<slug>` trong URL `multica.ai/<slug>` |
| `MULTICA_WORKSPACE_ID` | Không | UUID của workspace. Nếu đặt cả hai thì dùng UUID |
| `MULTICA_PROJECT_ID` | Không | ID project trong Multica. Bỏ trống thì issue không thuộc project nào |
| `JIRA_JQL` | Không | JQL riêng, thay cho `JIRA_PROJECT_KEY` |
| `STATUS_MAP` | Không | JSON một dòng, ví dụ `{"In Review":"in_review"}` |
| `MULTICA_SYNC_STATE` | Không | Đường dẫn file state, mặc định `~/.multica-sync/state-<workspace>.json` |

> `X-Workspace-ID` chỉ nhận **UUID**. Đừng điền slug hay tên workspace vào `MULTICA_WORKSPACE_ID`, hãy dùng `MULTICA_WORKSPACE_SLUG`.

## Cách chạy

Luôn chạy trong thư mục chứa script (script đọc `.env` ở thư mục hiện tại).

**Bước 1: chạy thử (dry run).** Không ghi gì vào Multica, chỉ in danh sách sẽ tạo hoặc cập nhật:
```bash
node sync-jira-to-multica.mjs
```

**Bước 2: ghi thử vài issue.**
```bash
node sync-jira-to-multica.mjs --apply --limit 3
```
Mở Multica kiểm tra 3 issue đó (title, status, priority, project). Chạy lại đúng lệnh này lần nữa: kết quả phải là `created: 0` và `unchanged: 3`.

**Bước 3: chạy toàn bộ.**
```bash
node sync-jira-to-multica.mjs --apply
```

### Các cờ

| Cờ | Tác dụng |
|---|---|
| `--apply` | Ghi thật vào Multica. Không có cờ này là dry run |
| `--limit N` | Chỉ xử lý N issue đầu |
| `--issue KEY[,KEY...]` | Chỉ sync các issue này, ví dụ `--issue ABC-12,ABC-15`. Thay cho `JIRA_PROJECT_KEY` và `JIRA_JQL` |
| `--sprint-labels` | Gắn label tên sprint (hoặc `Backlog` nếu không có sprint). Tự tạo label nếu chưa có |
| `--comments` | Thêm comment mới từ Jira sang Multica |
| `--refresh-comments` | Ghi lại cả comment đã đẩy trước đó theo cách chuyển đổi hiện tại. Bao gồm `--comments` |

Ví dụ:
```bash
node sync-jira-to-multica.mjs --apply --sprint-labels --comments
node sync-jira-to-multica.mjs --apply --issue ABC-12 --comments
```

### Đồng bộ lại sau khi Jira đổi

Script đọc tất cả issue trong JQL mỗi lần chạy, nhưng chỉ **ghi** sang Multica những issue có nội dung thay đổi (so sánh bằng hash). Muốn nhanh hơn:

- Chỉ vài ticket: dùng `--issue`.
- Chỉ ticket mới đổi gần đây:
  ```bash
  JIRA_JQL='project = "ABC" AND updated >= -1d ORDER BY created ASC' node sync-jira-to-multica.mjs --apply
  ```

Script **không tự chạy định kỳ**. Muốn tự động cần đặt lịch (cron, launchd...) trên máy luôn bật.

## Cần biết trước khi dùng

- **Một chiều.** Sửa issue trong Multica **không** đồng bộ ngược sang Jira.
- **Ghi đè.** Nếu bạn sửa title, description, status, priority hoặc due date trong Multica, rồi issue đó đổi bên Jira, lần chạy sau sẽ ghi đè phần bạn sửa. Nên sửa ở Jira.
- **File state.** Script lưu ánh xạ Jira key → Multica id vào file state (mặc định `~/.multica-sync/state-<workspace>.json`). File này không chứa nội dung ticket. Nếu mất file, chạy lại sẽ **tạo issue trùng**. Mỗi người hoặc mỗi workspace có file state riêng.
- **Comment.**
  - Tác giả comment trên Multica là chủ token, thời gian là lúc script chạy. Tên người viết và ngày của Jira được ghi vào đầu nội dung: `/note [Tên, 2026-11-18]`.
  - Tiền tố `/note` để Multica không chạy agent cho comment (xem phần chưa xác nhận bên dưới).
  - Sửa hoặc xóa comment bên Jira thì Multica không đổi (trừ khi dùng `--refresh-comments` để ghi lại bản sửa).
  - Nội dung quá 20000 ký tự bị cắt.
- **Sprint label.** Mỗi issue chỉ có một label sprint: sprint `active` ưu tiên, rồi `future`, rồi sprint cuối cùng. Tên label cắt còn 32 ký tự. Tắt `--sprint-labels` về sau không gỡ label đã gắn. Chỉ dùng khi site Jira có sprint.
- **Dữ liệu ticket (kể cả tên người comment) được gửi sang Multica.** Hãy chắc chắn nội dung phù hợp để đưa lên đó.

## Bảo mật

- **Không commit `.env`.** Thêm `.env` vào `.gitignore` **trước commit đầu tiên**.
- Không dán token vào chat, ticket hay PR.
- Token Multica truy cập được mọi workspace của tài khoản. Cân nhắc dùng tài khoản riêng.
- Dùng tài khoản Jira chỉ đọc cho script.
- Script chỉ in mã HTTP khi lỗi, không in nội dung phản hồi hay token.

## Xử lý lỗi

| Thông báo | Nguyên nhân thường gặp |
|---|---|
| `Missing required env var: ...` | Thiếu biến trong `.env`, hoặc chạy lệnh ở thư mục khác |
| `Set JIRA_PROJECT_KEY (or JIRA_JQL)...` | Chưa đặt project. Điền `JIRA_PROJECT_KEY` hoặc dùng `--issue` |
| `Set MULTICA_WORKSPACE_SLUG or MULTICA_WORKSPACE_ID` | Chưa chọn workspace |
| `Jira search failed with HTTP 401/403` | Sai email hoặc API token, hoặc không có quyền xem project |
| `Multica ... failed with HTTP 400` | `MULTICA_WORKSPACE_ID` không phải UUID (hãy dùng slug), hoặc status không có trong workspace (dùng `STATUS_MAP`, đặc biệt status `done`) |
| `Multica ... failed with HTTP 401` | Token sai, hết hạn hoặc bị revoke. Kiểm tra `MULTICA_TOKEN` và `MULTICA_API_URL` |
| `Multica ... failed with HTTP 404` | Slug sai, hoặc tài khoản không thuộc workspace |
| `No Sprint field found in Jira` | Site Jira không dùng sprint. Bỏ `--sprint-labels` |
| Kết quả toàn `0` với `--issue` | Key không tồn tại hoặc không có quyền xem |
| Issue bị tạo trùng | File state bị mất hoặc đổi workspace. Kiểm tra `MULTICA_SYNC_STATE` |

Kiểm tra token Multica riêng, không qua script (chỉ in mã HTTP, kết quả đúng là `200`):
```bash
(set -a; source .env; set +a; curl -s -o /dev/null -w "%{http_code}\n" "$MULTICA_API_URL/api/me" -H "Authorization: Bearer $MULTICA_TOKEN")
```
