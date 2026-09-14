# dich-proxy — Poiiky Dich Proxy

Cau noi dich phu de Trung → Viet giua app khach va VietAPI (gpt-5.6-luna).

- Key vendor **KHONG nam trong repo** — dat bang env `VIETAPI_KEY` tren Hostinger (Node.js app → Environment Variables).
- App khach gui `Authorization: Bearer <device-token>` (tu sinh tu license+HWID) de dem quota.
- Proxy GHI DE system prompt + ep model server-side → doi luat dich khong can build lai app.

## Chay local

```sh
npm install
VIETAPI_KEY=sk-xxx node index.js
curl http://127.0.0.1:8788/health
```

## Deploy Hostinger (Node.js app, subdomain dich.poiiky.com)

1. Ket noi repo nay trong muc Deploy (GitHub).
2. Entry/start: `node index.js` (cong doc tu env `PORT`).
3. Environment Variables: `VIETAPI_KEY=<key that>` (+ tuy chon `DICH_MAX_REQ_NGAY=800`).
4. Start → mo `https://dich.poiiky.com/health` phai tra `{"ok":true,...}`.

## Endpoint

- `GET /health` → `{ok, model, max_req_ngay}`
- `POST /v1/chat/completions` (Bearer device-token, khan OpenAI-compatible)
