# 🥞 Pancake → Getfly Sync

Middleware tự động đồng bộ người phụ trách đơn hàng từ **Pancake Chat** sang **Getfly CRM**.

## Luồng hoạt động

```
Pancake POS (đơn hàng)
        │
        ▼
Pancake Chat (lấy nhân viên phụ trách hội thoại)
        │
        ▼
Getfly CRM (cập nhật assigned_user + account_manager)
```

**Hai cơ chế sync:**
- **Webhook** — nhận sự kiện realtime khi có đơn mới từ Pancake POS
- **Scheduled Sync** — quét định kỳ đơn hàng N ngày gần nhất để bổ sung / sửa lại

---

## Yêu cầu

- Node.js >= 18 (hoặc Docker)
- Tài khoản Pancake POS + Pancake Chat + Getfly CRM
- (Để deploy) Dokploy hoặc bất kỳ Docker host nào

---

## Cài đặt & chạy local

### 1. Clone repo

```bash
git clone https://github.com/<your-username>/mcp-getfly-sync.git
cd mcp-getfly-sync
```

### 2. Cấu hình môi trường

```bash
cp .env.example .env
```

Chỉnh sửa `.env` với thông tin thực của bạn:

| Biến | Mô tả |
|------|-------|
| `PANCAKE_POS_API_KEY` | API key của Pancake POS |
| `PANCAKE_SHOP_ID` | ID shop trên Pancake POS |
| `PANCAKE_CHAT_PAGE_TOKEN` | Page token của Pancake Chat |
| `PANCAKE_CHAT_PAGE_ID` | Page ID của Pancake Chat |
| `GETFLY_API_KEY` | API key của Getfly CRM |
| `GETFLY_BASE_URL` | URL Getfly CRM (vd: `https://yourcompany.getflycrm.com`) |
| `WEBHOOK_SECRET` | Secret để xác thực webhook từ Pancake |
| `ADMIN_USER` | Username đăng nhập dashboard (mặc định: `admin`) |
| `ADMIN_PASS` | Password đăng nhập dashboard |
| `SESSION_SECRET` | Secret ngẫu nhiên cho session (tối thiểu 32 ký tự) |
| `ORDER_SYNC_INTERVAL` | Chu kỳ sync (ms), mặc định `300000` = 5 phút |
| `ORDER_SYNC_DAYS` | Số ngày quét lại, `0` = toàn bộ lịch sử |
| `CHAT_POLL_INTERVAL` | Chu kỳ poll chat (ms), mặc định `30000` = 30 giây |

### 3. Cài dependencies & chạy

```bash
npm install
npm run dev       # Dev (auto-reload)
npm start         # Production
```

Dashboard: [http://localhost:3000](http://localhost:3000)

---

## Deploy với Docker

### Build & run local

```bash
docker build -t mcp-getfly .
docker run -d \
  --name mcp-getfly \
  -p 3000:3000 \
  --env-file .env \
  -v mcp-getfly-data:/app/data \
  mcp-getfly
```

### Docker Compose

```bash
cp .env.example .env
# Chỉnh .env xong rồi:
docker compose up -d
```

---

## Deploy lên Dokploy

### Bước 1 — Push lên GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<username>/mcp-getfly-sync.git
git push -u origin main
```

### Bước 2 — Tạo Application trên Dokploy

1. Vào Dokploy Dashboard → **Create Application**
2. Chọn **GitHub** → chọn repo `mcp-getfly-sync`
3. **Build Type**: `Dockerfile`
4. **Port**: `3000`

### Bước 3 — Cấu hình Environment Variables trên Dokploy

Vào tab **Environment** của application, thêm tất cả các biến trong `.env.example`:

```
NODE_ENV=production
PANCAKE_POS_API_KEY=...
PANCAKE_SHOP_ID=...
PANCAKE_CHAT_PAGE_TOKEN=...
PANCAKE_CHAT_PAGE_ID=...
GETFLY_API_KEY=...
GETFLY_BASE_URL=...
WEBHOOK_SECRET=...
ADMIN_USER=admin
ADMIN_PASS=...           # Có thể để plain text, server sẽ tự hash bcrypt
SESSION_SECRET=...       # Random string dài >= 32 ký tự
ORDER_SYNC_INTERVAL=300000
ORDER_SYNC_DAYS=2
CHAT_POLL_INTERVAL=30000
```

### Bước 4 — Cấu hình Volume (persist data)

Vào tab **Volumes** → Add volume:
- **Container path**: `/app/data`
- **Host path**: `/var/lib/dokploy/volumes/mcp-getfly/data` (hoặc Dokploy tự tạo)

### Bước 5 — Deploy

Click **Deploy** → Dokploy sẽ build Docker image và chạy.

### Bước 6 — Cấu hình Webhook trên Pancake POS

Sau khi deploy xong, lấy URL domain từ Dokploy (ví dụ: `https://sync.example.com`), vào Pancake POS:

- **Webhook URL**: `https://sync.example.com/webhook/pancake-pos?secret=<WEBHOOK_SECRET>`
- **Events**: Order created / updated

---

## Cấu trúc dự án

```
src/
├── index.js          # Entry point, server setup
├── config.js         # Cấu hình từ env
├── routes/
│   ├── api.js        # Dashboard API
│   ├── auth.js       # Login/logout
│   └── webhook.js    # Nhận webhook từ Pancake POS
├── jobs/
│   ├── orderSync.js  # Scheduled sync (quét định kỳ)
│   └── chatPoller.js # Chat polling (theo dõi thay đổi assignee)
├── services/
│   ├── getfly.js     # Getfly CRM API client
│   ├── pancakeChat.js # Pancake Chat API client
│   └── pancakePOS.js  # Pancake POS API client
└── utils/
    ├── logger.js     # Logger (console + file)
    ├── orderStore.js # Lưu trạng thái đơn hàng
    └── staffMapper.js # Map nhân viên Pancake → Getfly
public/               # Dashboard frontend
data/                 # Runtime data (gitignored)
```

---

## API Endpoints

| Method | Path | Mô tả |
|--------|------|-------|
| `GET` | `/health` | Health check (public) |
| `GET` | `/status` | Trạng thái server |
| `POST` | `/webhook/pancake-pos` | Nhận webhook từ Pancake |
| `GET` | `/api/dashboard` | Tổng quan dashboard |
| `GET` | `/api/orders` | Danh sách đơn hàng đã sync |
| `POST` | `/api/sync/trigger` | Trigger sync thủ công |
| `GET` | `/api/sync/progress` | Tiến trình sync hiện tại |
| `GET` | `/api/events` | SSE realtime updates |
| `GET` | `/api/config` | Xem cấu hình (key bị mask) |
| `PUT` | `/api/config` | Cập nhật cấu hình |

---

## Bảo mật

- Dashboard yêu cầu đăng nhập (session-based)
- Password được hash bằng **bcrypt** (tự động upgrade lần đăng nhập đầu)
- Webhook xác thực bằng secret header/query param
- API keys trong dashboard response bị **mask** (chỉ hiện 4 ký tự đầu/cuối)
- Chạy sau reverse proxy (Cloudflare/Nginx/Traefik) với `trust proxy` đã được cấu hình

---

## License

MIT
