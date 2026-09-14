#!/usr/bin/env node
/**
 * dich-proxy.js — Poiiky Dich Proxy (P1 của PLAN-NANG-CAP-DICH-AI-VIET-HOA.md)
 *
 * Vai trò: cầu nối dịch phụ đề giữa app khách và VietAPI (gpt-5.6-luna).
 *  - Key vendor `sk-…` CHỈ nằm ở ĐÂY (env VIETAPI_KEY) — app khách KHÔNG chứa key.
 *  - Khách gửi Authorization: Bearer <device-token> (app tự sinh từ license+HWID, dùng cho quota).
 *  - Proxy GHI ĐÈ system message = BẢN LUẬT DỊCH CỐ ĐỊNH (sửa tại chỗ, mọi khách nhận ngay, khỏi build app).
 *  - Rate-limit theo device-token/ngày + log JSONL (đo chi phí).
 *
 * CHẠY LOCAL:  VIETAPI_KEY=sk-xxx node dich-proxy.js      (cổng 8788)
 * CHẠY HOSTINGER: app Node.js, cổng do host cấp qua env PORT (đã ưu tiên PORT ở CFG.port).
 * Endpoint (khớp khuôn OpenAI-compatible app đang gọi):
 *   POST <base>/v1/chat/completions   — forward + overwrite system
 *   GET  <base>/health                — {ok, model} (app thăm trước khi dịch)
 */
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CFG = {
  // Hostinger/Ploi Node app TỰ gán cổng qua env (đã có reverse-proxy sẵn) → ưu tiên các biến
  // cổng phổ biến của PaaS, fallback DICH_PORT cho chạy tay/VPS (mặc định 8788).
  // KHÔNG hardcode cổng — host mỗi nơi khác nhau.
  port: parseInt(process.env.PORT || process.env.APP_PORT || process.env.SERVER_PORT
    || process.env.HTTP_PORT || process.env.DICH_PORT || '8788'),
  upstream: process.env.VIETAPI_UPSTREAM || 'https://api.vietapi.tech/v1/chat/completions',
  key: process.env.VIETAPI_KEY || '',                       // BẮT BUỘC đặt bằng env — KHÔNG hardcode
  model: process.env.DICH_MODEL || 'gpt-5.6-luna',
  maxReqNgay: parseInt(process.env.DICH_MAX_REQ_NGAY || '800'),  // ~40 video/lượt-thiết-bị/ngày (≈20 req/video)
  timeoutMs: parseInt(process.env.DICH_TIMEOUT_MS || '150000'),
  dataDir: process.env.DICH_DATA_DIR || path.join(__dirname, 'dich-data'),
};
if (!CFG.key) { console.error('Thiếu env VIETAPI_KEY — proxy từ chối chạy.'); process.exit(1); }

// ═══ SYSTEM PROMPT CỐ ĐỊNH (bản nháp §3.4 plan — tinh chỉnh tại ĐÂY, không build lại app) ═══
const SYSTEM_PROMPT = `Bạn là dịch giả phụ đề chuyên nghiệp Trung → Việt, dịch lời thuyết minh video ngắn (Douyin/TikTok).

NGUYÊN TẮC (theo thứ tự ưu tiên):
1. ĐÚNG NGHĨA trước, MƯỢT sau. Không bịa thêm ý, không bỏ ý, không tóm lược.
2. Đọc TOÀN BỘ danh sách câu trước khi dịch: đây là lời liên tục của 1 video. Đại từ, xưng hô,
   tên nhân vật phải NHẤT QUÁN từ đầu đến cuối.
3. TỪ ĐA NGHĨA: chọn nghĩa theo ngữ cảnh cả đoạn, KHÔNG lấy nghĩa đầu trong từ điển.
   (vd 不念了 = nghỉ học/bỏ học, KHÔNG phải "không đọc"; 借宿 = ở nhờ; 寝 = phòng ký túc).
4. Suy ra QUAN HỆ từ câu trước–sau để chọn xưng hô: thầy–trò, cha/mẹ–con, vợ–chồng, bạn bè,
   sếp–nhân viên, người kể chuyện ngôi thứ nhất... Dùng "mày/tao" chỉ khi quan hệ rất thân hoặc
   thô tục rõ ràng; mặc định an toàn là "anh/em/cô/chú/bạn".
5. TÊN RIÊNG: dùng tên Hán-Việt quen thuộc (赵丽颖 → Triệu Lộ Tư). Không giữ chữ Hán, không để pinyin.
   Nếu có BẢNG TÊN RIÊNG ở cuối prompt → dùng ĐÚNG bảng đó.
6. SỐ, ĐƠN VỊ, TIỀN, ĐỊA DANH: viết theo chuẩn Việt ("3 triệu tệ", "12 giờ", "Bắc Kinh").
7. GIỮ CẢM XÚC và dụng ý của câu: câu hỏi giữ ngữ điệu hỏi, câu cảm thán giữ ngữ điệu cảm,
   nói lóng/thành ngữ → tìm tương đương Việt, không dịch sát từng chữ.
8. KHÔNG để sót bất kỳ chữ Hán/pinyin nào trong bản dịch.
9. MỖI dòng gốc = ĐÚNG 1 dòng dịch, GIỮ ĐÚNG SỐ thứ tự của nó. TUYỆT ĐỐI không gộp dòng,
   không bỏ dòng, không đánh số lại, không thêm ghi chú. Bỏ 1 dòng làm lệch toàn bộ phụ đề phía sau.
10. Bản dịch phải ĐỌC TỰ NHIÊN như người Việt nói, không văn phong "dịch máy".

ĐỊNH DẠNG ĐẦU RA: chỉ trả các dòng dạng \`số|bản dịch\`. Không giải thích, không markdown, không bảng.`;

// ═══ Quota theo device-token × ngày (file JSON đơn giản — Business host không cần Redis) ═══
const homNy = () => new Date().toISOString().slice(0, 10);
const demFile = path.join(CFG.dataDir, 'dem.json');
const logFile = () => path.join(CFG.dataDir, 'su-dung-' + homNy() + '.jsonl');
let _dem = {};
try { fs.mkdirSync(CFG.dataDir, { recursive: true }); _dem = JSON.parse(fs.readFileSync(demFile, 'utf8')); } catch (e) { _dem = {}; }
if (_dem.ngay !== homNy()) _dem = { ngay: homNy() };
const _ghiDem = () => { try { fs.writeFileSync(demFile, JSON.stringify(_dem)); } catch (e) { console.error('ghi dem.json fail:', e.message); } };
const _tokenKhoa = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);
const _thongKe = (tk, tokIn, tokOut, ma) => {
  const line = JSON.stringify({ t: new Date().toISOString(), tk, ngay: homNy(), tok_in: tokIn, tok_out: tokOut, http: ma }) + '\n';
  try { fs.appendFileSync(logFile(), line); } catch (e) { console.error('ghi jsonl fail:', e.message); }
};

// ═══ Forward lên VietAPI (khuôn OpenAI-compatible) ═══
function _forward(jsonBody) {
  return new Promise((resolve, reject) => {
    const u = new URL(CFG.upstream);
    const data = Buffer.from(JSON.stringify(jsonBody), 'utf8');
    const _mod = u.protocol === "http:" ? require("http") : https;
    const r = _mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search, method: 'POST', timeout: CFG.timeoutMs,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + CFG.key,
                 'Content-Length': data.length },
    }, (res) => {
      let txt = ''; res.on('data', (c) => txt += c);
      res.on('end', () => resolve({ status: res.statusCode, txt }));
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(new Error('timeout upstream')); });
    r.write(data); r.end();
  });
}

// ═══ Express app (Hostinger nhận diện framework qua Express) ═══
const app = express();
app.disable('x-powered-by');
// trần 2MB khớp hành vi http-server cũ (body quá lớn → 413/400 thay vì nuốt chửng RAM)
app.use(express.json({ limit: '2mb' }));

// Root + /health — Hostinger có thể probe '/'; app khách gọi '/health' trước khi dịch
const _health = (req, res) => res.status(200).json({ ok: true, model: CFG.model, max_req_ngay: CFG.maxReqNgay });
app.get('/', _health);
app.get('/health', _health);

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: { message: 'Thiếu device token — app chưa kích hoạt license?' } });

    const tk = _tokenKhoa(token);
    if ((_dem[tk] || 0) >= CFG.maxReqNgay) {
      return res.status(429).set('Retry-After', '3600')
        .json({ error: { message: 'Vượt trần dịch vụ hôm nay — thử lại sau hoặc dùng Gemini web.' } });
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    // ÉP khuôn của DỊCH VỤ: model do proxy quyết (đổi server-side không cần build app);
    // system message do proxy ghi đè (luật dịch cố định); khách không điều khiển được 2 thứ này.
    body.model = CFG.model;
    body.stream = false;
    const msgs = (body.messages || []).filter(m => m && m.role !== 'system');
    body.messages = [{ role: 'system', content: SYSTEM_PROMPT }].concat(msgs);
    if (!msgs.length) return res.status(400).json({ error: { message: 'messages rỗng' } });

    const up = await _forward(body);
    _dem[tk] = (_dem[tk] || 0) + 1; _ghiDem();
    let ti = 0, to = 0;
    try { const j = JSON.parse(up.txt); const u = (j && j.usage) || {}; ti = u.prompt_tokens | u.promptTokenCount || 0; to = u.completion_tokens | u.candidatesTokenCount || 0; } catch (e) {}
    _thongKe(tk, ti, to, up.status);
    // Trả NGUYÊN văn upstream (kể cả mã lỗi) — app khách đọc choices/error như gọi OpenAI trực tiếp
    return res.status(up.status).type('application/json; charset=utf-8').send(up.txt);
  } catch (e) {
    console.error('proxy error:', e.message);
    return res.status(502).json({ error: { message: 'Proxy lỗi: ' + String(e.message).slice(0, 120) } });
  }
});

// 404 mặc định cho route còn lại (khớp hành vi cũ)
app.use((req, res) => res.status(404).json({ error: { message: 'Không có route. thử /health hoặc /v1/chat/completions' } }));

// ═══ LISTEN ═══
// Hostinger (LiteSpeed) KHÔNG cấp cổng TCP qua env — nó đưa UDS qua LSNODE_SOCKET
// (đo env-debug 15/09/2026 xác nhận: không có PORT nào, chỉ có LSNODE_SOCKET/LSNODE_ROOT).
// → Ưu tiên listen unix socket; LSNODE_ROOT có thể là tiền tố tương đối của socket path.
// Fallback TCP (PORT/env/không) cho VPS, Docker, chạy tay.
let _listening = false;
const _logLive = (mo) => console.log('Poiiky Dich Proxy ' + mo + ' → ' + CFG.upstream +
  ' (model ' + CFG.model + ', trần ' + CFG.maxReqNgay + ' req/token/ngày)');

if (process.env.LSNODE_SOCKET) {
  try {
    let sock = String(process.env.LSNODE_SOCKET);
    if (!path.isAbsolute(sock) && process.env.LSNODE_ROOT) {
      sock = path.join(process.env.LSNODE_ROOT, sock);   // LiteSpeed ghi tương đối so với root
    }
    // Xóa socket cặn của lần chạy trước — còn file là listen() die EADDRINUSE
    try { if (fs.existsSync(sock)) fs.unlinkSync(sock); } catch (e) { console.error('unlink socket cu:', e.message); }
    const server = app.listen(sock, () => {
      _listening = true;
      _logLive('UDS ' + sock);
      // LiteSpeed chạy cùng user → quyền 0660 an toàn hơn 0777
      try { fs.chmodSync(sock, 0o660); } catch (_) {}
    });
    server.on('error', (e) => {
      if (_listening) return;   // lỗi sau khi đã live (client đóng socket…) → không fallback chồng
      console.error('Loi listen UDS (' + e.code + ' ' + e.message + ') → thu TCP cong ' + CFG.port);
      _listening = true;
      const fb = app.listen(CFG.port, () => _logLive(':' + CFG.port + ' (fallback)'));
      fb.on('error', (e2) => console.error('Fallback TCP cung loi (' + e2.code + ') — dung process'));
    });
  } catch (e) {
    console.error('Loi giai ma LSNODE_SOCKET (' + e.message + ') → dung TCP');
    if (!_listening) { _listening = true; app.listen(CFG.port, () => _logLive(':' + CFG.port)); }
  }
} else {
  _listening = true;
  app.listen(CFG.port, () => _logLive(':' + CFG.port));
}
