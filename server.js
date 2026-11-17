const express = require('express'), http = require('http'), crypto = require('crypto');
const fs = require('fs'), path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = process.env.BOT_USERNAME || '';
const DEV = process.env.DEV === '1'; // faqat kompyuterda sinash uchun
const ADMINS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

/* ---------------- Ma'lumotlar bazasi (JSON fayl) ---------------- */
let db = { users: {}, players: [], packs: [], tx: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE + '.tmp', JSON.stringify(db), err => { if (!err) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {}); });
  }, 300);
}
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rating = p => Math.round((p.spd + p.sht + p.pas + p.def) / 4);
const newId = () => Date.now() * 1000 + rnd(0, 999);
function seed() {
  const names = ['Anvar Rustam', 'Bekzod Mirza', 'Dilshod Aka', 'Eldor Pele', 'Farrux Tez', 'Jasur Gol', 'Kamol Devor', 'Lazizbek Pas', 'Nodir Qanot', 'Otabek Zarba', 'Sardor Temir', 'Umid Chaqqon'];
  const pos = ['FW', 'MF', 'DF', 'GK'];
  db.players = names.map((n, i) => ({ id: i + 1, name: n, pos: pos[i % 4], spd: rnd(50, 94), sht: rnd(50, 94), pas: rnd(50, 94), def: rnd(40, 89), img: '' }));
  db.packs = [
    { id: 1, name: 'Oddiy pack', img: '', gp: 2000, coins: 100, cnt: 1, pool: db.players.slice(0, 8).map(p => p.id) },
    { id: 2, name: 'Katta pack', img: '', gp: 5000, coins: 900, cnt: 10, pool: db.players.map(p => p.id) }
  ];
  save();
}
if (!db.players.length) seed();
function logTx(uid, gp, coins, why) {
  db.tx.push({ t: Date.now(), uid: String(uid), gp, coins, why });
  if (db.tx.length > 5000) db.tx = db.tx.slice(-3000);
}
function getUser(id, name) {
  id = String(id);
  if (!db.users[id]) { db.users[id] = { gp: 1000, coins: 100, owned: [], name: name || '' }; save(); }
  return db.users[id];
}
const isAdmin = id => ADMINS.includes(String(id));

/* ---------------- Telegram initData tekshiruvi ---------------- */
function verifyInitData(init) {
  if (!init || !BOT_TOKEN) return null;
  const p = new URLSearchParams(init);
  const hash = p.get('hash');
  p.delete('hash');
  const str = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (!hash || calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}
function authUser(init, devId) {
  const u = verifyInitData(init);
  if (u) return u;
  if (DEV && devId) return { id: Number(devId), first_name: 'Dev' + devId };
  return null;
}

/* ---------------- HTTP API ---------------- */
const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '6mb' }));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (q, r) => r.send('ok'));

function auth(req, res, next) {
  const u = authUser(req.get('x-init-data'), req.get('x-dev-id'));
  if (!u) return res.status(401).json({ error: 'Telegram orqali oching' });
  req.uid = String(u.id);
  req.admin = isAdmin(u.id);
  req.rec = getUser(u.id, u.first_name);
  next();
}
function adminOnly(req, res, next) { req.admin ? next() : res.status(403).json({ error: 'Ruxsat yo\'q' }); }
const clamp = (v, a, b) => Math.min(b, Math.max(a, Math.round(Number(v)) || a));

app.get('/api/me', auth, (req, res) => {
  res.json({
    id: req.uid, admin: req.admin, bot: BOT_USERNAME,
    gp: req.rec.gp, coins: req.rec.coins, owned: req.rec.owned,
    players: db.players,
    packs: db.packs.map(k => (req.admin ? k : { id: k.id, name: k.name, img: k.img, gp: k.gp, coins: k.coins, cnt: k.cnt }))
  });
});

app.post('/api/buy', auth, (req, res) => {
  const k = db.packs.find(x => x.id === req.body.packId);
  const cur = req.body.cur;
  if (!k || !['gp', 'coins'].includes(cur)) return res.status(400).json({ error: 'Noto\'g\'ri so\'rov' });
  const price = cur === 'gp' ? k.gp : k.coins;
  if (!req.admin && req.rec[cur] < price) return res.status(400).json({ error: cur === 'gp' ? 'GP yetarli emas' : 'Coins yetarli emas' });
  const pool = db.players.filter(p => k.pool.includes(p.id));
  if (!pool.length) return res.status(400).json({ error: 'Packda o\'yinchi yo\'q' });
  if (!req.admin) req.rec[cur] -= price;
  const w = pool.map(p => Math.max(1, 100 - rating(p))), total = w.reduce((a, b) => a + b, 0), got = [];
  for (let i = 0; i < k.cnt; i++) {
    let t = Math.random() * total, j = 0;
    while (j < w.length - 1 && t > w[j]) { t -= w[j]; j++; }
    got.push(pool[j].id);
  }
  req.rec.owned.push(...got);
  logTx(req.uid, cur === 'gp' ? -price : 0, cur === 'coins' ? -price : 0, 'pack:' + k.id);
  save();
  res.json({ got });
});

app.post('/api/admin/upload', auth, adminOnly, (req, res) => {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(req.body.data || '');
  if (!m) return res.status(400).json({ error: 'Faqat PNG, JPG yoki WEBP' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'Rasm 3 MB dan katta' });
  const name = crypto.randomBytes(8).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFile(path.join(DATA_DIR, 'uploads', name), buf, err => err ? res.status(500).json({ error: 'Saqlab bo\'lmadi' }) : res.json({ url: '/uploads/' + name }));
});

app.post('/api/admin/player', auth, adminOnly, (req, res) => {
  const b = req.body, name = String(b.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Ism kiriting' });
  const p = {
    id: newId(), name, pos: ['FW', 'MF', 'DF', 'GK'].includes(b.pos) ? b.pos : 'FW',
    spd: clamp(b.spd, 1, 99), sht: clamp(b.sht, 1, 99), pas: clamp(b.pas, 1, 99), def: clamp(b.def, 1, 99),
    img: String(b.img || '').startsWith('/uploads/') ? b.img : ''
  };
  db.players.push(p); save(); res.json(p);
});
app.delete('/api/admin/player/:id', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  db.players = db.players.filter(p => p.id !== id);
  db.packs.forEach(k => k.pool = k.pool.filter(x => x !== id));
  save(); res.json({ ok: true });
});

app.post('/api/admin/pack', auth, adminOnly, (req, res) => {
  const b = req.body, name = String(b.name || '').trim().slice(0, 30);
  const pool = (Array.isArray(b.pool) ? b.pool : []).filter(id => db.players.some(p => p.id === id));
  if (!name) return res.status(400).json({ error: 'Pack nomini kiriting' });
  if (!pool.length) return res.status(400).json({ error: 'Kamida bitta o\'yinchi tanlang' });
  const k = {
    id: newId(), name, img: String(b.img || '').startsWith('/uploads/') ? b.img : '',
    gp: clamp(b.gp, 0, 1e9), coins: clamp(b.coins, 0, 1e9), cnt: clamp(b.cnt, 1, 20), pool
  };
  db.packs.push(k); save(); res.json(k);
});
app.delete('/api/admin/pack/:id', auth, adminOnly, (req, res) => {
  db.packs = db.packs.filter(k => k.id !== Number(req.params.id)); save(); res.json({ ok: true });
});

app.post('/api/admin/give', auth, adminOnly, (req, res) => {
  const b = req.body, target = String(b.uid || req.uid).trim();
  if (!/^\d+$/.test(target)) return res.status(400).json({ error: 'ID noto\'g\'ri' });
  const rec = getUser(target);
  const gp = clamp(b.gp, -1e7, 1e7) || 0, coins = clamp(b.coins, -1e7, 1e7) || 0;
  rec.gp = Math.max(0, rec.gp + (Number(b.gp) ? gp : 0));
  rec.coins = Math.max(0, rec.coins + (Number(b.coins) ? coins : 0));
  if (b.playerId && db.players.some(p => p.id === Number(b.playerId))) rec.owned.push(Number(b.playerId));
  logTx(target, gp, coins, 'admin:' + req.uid);
  save(); res.json({ ok: true });
});

/* ---------------- O'yin mexanikasi (serverda): 11 ga 11 ---------------- */
const W = 2600, H = 1400, M = 100, GW = 300, FW = W - 2 * M, FH = H - 2 * M, N = 11; // katta stadion (kamera to'pni kuzatadi)
const SPEED = Number(process.env.GAME_SPEED) || .7; // o'yin tezligi: kichikroq = sekinroq (Render'da GAME_SPEED o'zgaruvchisi)
// 4-4-2: [maydon bo'ylab, ko'ndalang] (0 = o'z darvozasi, 1 = raqib darvozasi)
const FORM = [[.03, .5], [.2, .15], [.2, .38], [.2, .62], [.2, .85], [.42, .15], [.42, .38], [.42, .62], [.42, .85], [.62, .36], [.62, .64]];
const games = new Set(), rooms = new Map();
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const cl = (v, a, b) => Math.min(b, Math.max(a, v));
const home = (side, i) => { const f = FORM[i]; return [side ? W - M - f[0] * FW : M + f[0] * FW, M + f[1] * FH]; };
function mkPlayer(side, i) {
  const h = home(side, i);
  return { idx: side * N + i, side, i, x: h[0], y: h[1], hx: h[0], hy: h[1], vx: 0, vy: 0, r: 22, st: 100, jx: 0, jy: 0, run: false, fx: side ? -1 : 1, fy: 0, kc: 0 };
}
function newGame(mode, socks) {
  const mkIn = () => ({ jx: 0, jy: 0, run: false, pjy: 0, flT: 0, flS: 0 });
  const g = {
    mode, socks, p: [], b: { x: W / 2, y: H / 2, vx: 0, vy: 0, r: 14 }, sc: [0, 0], t: mode === 'ai' ? 300 : 600,
    pause: 1, over: false, tick: 0, hum: [true, mode === 'friend'], ctl: [9, 9], ct: [0, 0], dtc: [0, 0], lk: -1, kt: 0, in: [mkIn(), mkIn()]
  };
  for (let s = 0; s < 2; s++) for (let i = 0; i < N; i++) g.p.push(mkPlayer(s, i));
  games.add(g);
  socks.forEach((s, i) => { if (s) { s.data.game = g; s.data.side = i; s.emit('game:start', { side: i, mode }); } });
  return g;
}
function resetPos(g) {
  g.p.forEach(p => { p.x = p.hx; p.y = p.hy; p.vx = p.vy = 0; });
  Object.assign(g.b, { x: W / 2, y: H / 2, vx: 0, vy: 0 });
  g.ctl = [9, 9]; g.pause = 1.2;
}
const near = (g, p, extra = 24) => dist(p, g.b) <= p.r + g.b.r + extra;
function kick(g, p, dx, dy, pw) {
  if (!near(g, p, 24)) return false;
  const l = Math.hypot(dx, dy) || 1;
  g.b.vx = dx / l * pw; g.b.vy = dy / l * pw;
  g.lk = p.idx; g.kt = .25;
  return true;
}
function nearestOut(g, side, ex) {
  let bi = -1, bd = 1e9;
  for (let i = 1; i < N; i++) {
    if (i === ex) continue;
    const d = dist(g.p[side * N + i], g.b);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}
function passTarget(g, p, dx, dy, min) {
  const l = Math.hypot(dx, dy) || 1;
  let best = null, bs = -9;
  for (let i = 0; i < N; i++) {
    if (i === p.i) continue;
    const q = g.p[p.side * N + i], vx = q.x - p.x, vy = q.y - p.y, d = Math.hypot(vx, vy);
    if (d < 110 || d > 1000) continue;
    const c = (vx * dx + vy * dy) / (d * l);
    if (c < min) continue;
    const sc = c * 2 - d / 900 - (i === 0 ? 1.5 : 0);
    if (sc > bs) { bs = sc; best = q; }
  }
  return best;
}
// Odam boshqarayotgan o'yinchi tugmalari: S = zarba, P = pas (to'pdan uzoq bo'lsa o'yinchini almashtiradi), T = through
function doKick(g, side, k) {
  if (g.pause > 0) return;
  const p = g.p[side * N + g.ctl[side]], I = g.in[side];
  if (!near(g, p)) {
    if (k === 'P') { const n = nearestOut(g, side, g.ctl[side]); if (n > 0) { g.ctl[side] = n; g.ct[side] = .4; } }
    return;
  }
  const mv = I.jx || I.jy, dx = mv ? I.jx : p.fx, dy = mv ? I.jy : p.fy;
  if (k === 'S') {
    const gx = side ? M : W - M, tx = gx - p.x, ty = H / 2 - p.y, dg = Math.hypot(tx, ty);
    let d = [dx, dy];
    if (dg < 900 && (dx * tx + dy * ty) / (dg * (Math.hypot(dx, dy) || 1)) > .5) d = [tx, H / 2 + cl(I.jy, -1, 1) * GW * .38 - p.y];
    kick(g, p, d[0], d[1], 950);
  } else {
    const through = k === 'T', q = passTarget(g, p, dx, dy, .55);
    if (q) {
      let tx = q.x, ty = q.y;
      if (through) tx = cl(q.x + (side ? -230 : 230), M + 10, W - M - 10);
      kick(g, p, tx - p.x, ty - p.y, cl(Math.hypot(tx - p.x, ty - p.y) * (through ? 1.05 : .98), 300, 1100));
    } else kick(g, p, dx, dy, through ? 700 : 520);
  }
}
function doubleTouch(g, side) {
  const p = g.p[side * N + g.ctl[side]], b = g.b;
  if (g.pause > 0 || g.dtc[side] > 0 || !near(g, p, 40)) return;
  g.dtc[side] = 2.5;
  b.vx = p.fx * 300; b.vy = p.fy * 300;
  const fs = g.in[side].flS;
  setTimeout(() => {
    if (g.over) return;
    b.vx = p.fx * 420; b.vy = p.fy * 420;
    p.vx = p.fx * 520; p.vy = (p.fy + fs * .9) * 520;
  }, 150 / SPEED);
}
// Kompyuter boshqaradigan o'yinchi (darvozabon, chaser, qolganlari pozitsiyada)
function ai(g, p, dt, chaser) {
  const b = g.b;
  let tx, ty, lv = .8;
  p.kc = Math.max(0, p.kc - dt);
  if (p.i === 0) {
    const gx = p.side ? W - M - 40 : M + 40;
    tx = gx; ty = cl(b.y, H / 2 - GW * .75, H / 2 + GW * .75);
    if (Math.abs(b.x - gx) < 400 && Math.abs(b.y - H / 2) < 330 && dist(p, b) < 340) { tx = b.x; ty = b.y; lv = 1; }
    if (!p.kc && near(g, p, 22)) { kick(g, p, p.side ? -1 : 1, (Math.random() - .5) * 1.2, 760); p.kc = .8; }
  } else if (chaser) {
    tx = b.x + b.vx * .25; ty = b.y + b.vy * .25; lv = .92;
    if (!g.hum[p.side] && !p.kc && near(g, p, 20)) { // kompyuter jamoasi harakati
      const gx = p.side ? M : W - M, dg = Math.abs(gx - p.x), r = Math.random();
      if (dg < 650 && Math.abs(p.y - H / 2) < 400) kick(g, p, gx - p.x, H / 2 + (Math.random() - .5) * GW * .7 - p.y, 850);
      else if (r < .4) {
        const q = passTarget(g, p, gx - p.x, H / 2 - p.y, .5);
        if (q) kick(g, p, q.x - p.x, q.y - p.y, cl(dist(p, q) * .98, 300, 1000)); else kick(g, p, gx - p.x, H / 2 - p.y, 380);
      } else kick(g, p, gx - p.x, H / 2 - p.y, 380);
      p.kc = .5;
    }
  } else {
    tx = cl(p.hx + (b.x - W / 2) * .35, M + 20, W - M - 20);
    ty = cl(p.hy + (b.y - H / 2) * .25, M + 20, H - M - 20);
  }
  const dx = tx - p.x, dy = ty - p.y, l = Math.hypot(dx, dy), sp = l > 8 ? Math.min(1, l / 70) * lv : 0;
  p.jx = l ? dx / l * sp : 0; p.jy = l ? dy / l * sp : 0; p.run = false;
}
function step(g, dt) {
  const b = g.b;
  g.dtc[0] = Math.max(0, g.dtc[0] - dt); g.dtc[1] = Math.max(0, g.dtc[1] - dt);
  if (g.pause > 0) { g.pause -= dt; return; }
  g.t -= dt;
  if (g.t <= 0) return finish(g, 'time');
  g.kt = Math.max(0, g.kt - dt);
  const sdt = dt * SPEED; // harakat va to'p fizikasi sekinlashtiriladi, vaqt va sovish esa haqiqiy
  const chaser = [-1, -1];
  for (let s = 0; s < 2; s++) {
    if (g.hum[s]) { // to'pga eng yaqin o'yinchi avtomatik tanlanadi
      g.ct[s] -= dt;
      const cur = g.ctl[s], best = nearestOut(g, s, -1);
      if (best !== cur && g.ct[s] <= 0 && dist(g.p[s * N + best], b) + 35 < dist(g.p[s * N + cur], b)) { g.ctl[s] = best; g.ct[s] = .3; }
    } else chaser[s] = nearestOut(g, s, -1);
  }
  for (const p of g.p) {
    const s = p.side;
    if (g.hum[s] && g.ctl[s] === p.i) { const I = g.in[s]; p.jx = I.jx; p.jy = I.jy; p.run = I.run; }
    else ai(g, p, dt, chaser[s] === p.i);
    const sp = 300 * (p.run && p.st > 0 ? 1.45 : 1);
    if (p.run && (p.jx || p.jy)) p.st = Math.max(0, p.st - 28 * dt); else p.st = Math.min(100, p.st + 14 * dt);
    const k = Math.min(1, sdt * 9);
    p.vx += (p.jx * sp - p.vx) * k; p.vy += (p.jy * sp - p.vy) * k;
    if (p.jx || p.jy) { const l = Math.hypot(p.jx, p.jy); p.fx = p.jx / l; p.fy = p.jy / l; }
    p.x = cl(p.x + p.vx * sdt, M, W - M); p.y = cl(p.y + p.vy * sdt, M, H - M);
  }
  for (let i = 0; i < g.p.length; i++) for (let j = i + 1; j < g.p.length; j++) { // o'yinchilar bir-birining ustiga chiqmasin
    const a = g.p[i], c = g.p[j], dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy);
    if (d < 36 && d > 0) { const o = (36 - d) / 2, nx = dx / d, ny = dy / d; a.x -= nx * o; a.y -= ny * o; c.x += nx * o; c.y += ny * o; }
  }
  for (const p of g.p) {
    const ex = b.x - p.x, ey = b.y - p.y, ed = Math.hypot(ex, ey), mn = p.r + b.r;
    if (ed < mn && ed > 0) {
      const nx = ex / ed, ny = ey / ed;
      b.x = p.x + nx * mn; b.y = p.y + ny * mn;
      if (g.lk === p.idx && g.kt > 0) continue;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 450) { const k = p.i === 0 ? .1 : .3; b.vx = b.vx * k + nx * 140 + p.vx * .3; b.vy = b.vy * k + ny * 140 + p.vy * .3; } // tez to'p to'siladi (darvozabon ushlaydi)
      else { b.vx += p.vx * .35 + nx * 80; b.vy += p.vy * .35 + ny * 80; }
    }
  }
  b.x += b.vx * sdt; b.y += b.vy * sdt;
  const f = Math.pow(.38, sdt); b.vx *= f; b.vy *= f;
  const inG = Math.abs(b.y - H / 2) < GW / 2;
  if (b.y < M + b.r) { b.y = M + b.r; b.vy = Math.abs(b.vy) * .8; }
  if (b.y > H - M - b.r) { b.y = H - M - b.r; b.vy = -Math.abs(b.vy) * .8; }
  if (b.x < M) { if (inG) { g.sc[1]++; return resetPos(g); } b.x = M; b.vx = Math.abs(b.vx) * .8; }
  if (b.x > W - M) { if (inG) { g.sc[0]++; return resetPos(g); } b.x = W - M; b.vx = -Math.abs(b.vx) * .8; }
}
function finish(g, reason, leaver) {
  if (g.over) return;
  g.over = true; games.delete(g);
  g.socks.forEach((s, i) => {
    if (!s) return;
    s.data.game = null;
    if (s === leaver) return;
    let reward = 0;
    if (reason === 'time') {
      const rec = getUser(s.data.uid), win = g.sc[i] > g.sc[1 - i];
      if (g.mode === 'ai') { if (win) reward = 50; }
      else {
        const day = new Date().toISOString().slice(0, 10);
        if (!rec.fd || rec.fd.day !== day) rec.fd = { day, n: 0 };
        if (rec.fd.n < 10) { rec.fd.n++; reward = 200; } // kuniga 10 ta o'yin uchun mukofot
      }
      if (reward) { rec.gp += reward; logTx(s.data.uid, reward, 0, 'match:' + g.mode); }
    }
    s.emit('end', { sc: g.sc, side: i, reward, reason });
  });
  save();
}
let lastT = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(.05, (now - lastT) / 1000); lastT = now;
  for (const g of [...games]) {
    step(g, dt);
    if (g.over) continue;
    if (++g.tick % 2 === 0) {
      const st = {
        p: g.p.map(p => [Math.round(p.x), Math.round(p.y)]), b: [Math.round(g.b.x), Math.round(g.b.y)],
        sc: g.sc, t: Math.ceil(g.t), c: g.ctl, st: [Math.round(g.p[g.ctl[0]].st), Math.round(g.p[N + g.ctl[1]].st)]
      };
      g.socks.forEach(s => s && s.emit('st', st));
    }
  }
}, 1000 / 60);

/* ---------------- Socket.IO: lobbi va o'yin ---------------- */
const io = new Server(server);
io.use((s, next) => {
  const u = authUser(s.handshake.auth.initData, s.handshake.auth.devId);
  if (!u) return next(new Error('auth'));
  s.data.uid = String(u.id); s.data.name = u.first_name || 'O\'yinchi';
  getUser(u.id, u.first_name);
  next();
});
const genCode = () => {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s;
  do { s = Array.from({ length: 5 }, () => c[rnd(0, c.length - 1)]).join(''); } while (rooms.has(s));
  return s;
};
function updateRoom(r) {
  r.members.forEach((s, i) => s.emit('lobby:update', { code: r.code, n: r.members.length, host: i === 0 }));
}
function leaveAll(s) {
  const g = s.data.game;
  if (g && !g.over) finish(g, 'left', s);
  const code = s.data.room;
  if (code) {
    const r = rooms.get(code);
    if (r) { r.members = r.members.filter(x => x !== s); if (!r.members.length) rooms.delete(code); else updateRoom(r); }
    s.data.room = null;
  }
}
io.on('connection', s => {
  s.on('ai:start', () => { if (s.data.game) return; leaveAll(s); newGame('ai', [s, null]); });

  s.on('lobby:create', cb => {
    if (typeof cb !== 'function' || s.data.game) return;
    leaveAll(s);
    const r = { code: genCode(), members: [s] };
    rooms.set(r.code, r); s.data.room = r.code;
    setTimeout(() => { if (rooms.get(r.code) === r) rooms.delete(r.code); }, 15 * 60 * 1000);
    cb({ code: r.code }); updateRoom(r);
  });
  s.on('lobby:join', (code, cb) => {
    if (typeof cb !== 'function' || s.data.game) return;
    code = String(code || '').toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return cb({ error: 'Bunday xona topilmadi' });
    if (r.members.length >= 2) return cb({ error: 'Xona to\'lgan' });
    if (r.members[0].data.uid === s.data.uid) return cb({ error: 'Bu sizning xonangiz' });
    leaveAll(s);
    r.members.push(s); s.data.room = code;
    cb({ code }); updateRoom(r);
  });
  s.on('lobby:start', () => {
    const r = rooms.get(s.data.room);
    if (!r || r.members[0] !== s || r.members.length < 2) return;
    rooms.delete(r.code);
    r.members.forEach(m => { m.data.room = null; });
    newGame('friend', r.members);
  });

  s.on('in', d => {
    const g = s.data.game;
    if (!g || g.over || !d) return;
    const side = s.data.side, I = g.in[side];
    let jx = Number(d.jx) || 0, jy = Number(d.jy) || 0;
    const l = Math.hypot(jx, jy);
    if (l > 1) { jx /= l; jy /= l; }
    I.jx = jx; I.jy = jy;
    const now = Date.now();
    if (Math.abs(jy) > .75 && Math.abs(I.pjy) < .45) { I.flT = now; I.flS = jy < 0 ? -1 : 1; } // joystik tez tepaga/pastga
    I.pjy = jy;
    const run = !!d.run;
    if (run && !I.run && now - I.flT < 600) { doubleTouch(g, side); I.flT = 0; } // keyin Yugurish bosildi
    I.run = run;
  });
  s.on('act', d => {
    const g = s.data.game;
    if (g && !g.over && d && ['S', 'P', 'T'].includes(d.k)) doKick(g, s.data.side, d.k);
  });
  s.on('game:leave', () => leaveAll(s));
  s.on('disconnect', () => leaveAll(s));
});

server.listen(PORT, () => console.log('Server ishga tushdi: ' + PORT));
