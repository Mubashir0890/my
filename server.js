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

/* ---------------- O'yin mexanikasi (serverda) ---------------- */
const W = 1280, H = 720, M = 70, GW = 170;
const games = new Set(), rooms = new Map();
const mkPlayer = x => ({ x, y: H / 2, vx: 0, vy: 0, r: 20, st: 100, jx: 0, jy: 0, run: false, fx: 1, fy: 0, pjy: 0, flT: 0, flS: 0, dtCd: 0, kc: 0 });

function newGame(mode, socks) {
  const g = { mode, socks, p: [mkPlayer(M + 300), mkPlayer(W - M - 300)], b: { x: W / 2, y: H / 2, vx: 0, vy: 0, r: 10 }, sc: [0, 0], t: mode === 'ai' ? 300 : 600, pause: 1, over: false, tick: 0 };
  g.p[1].fx = -1;
  games.add(g);
  socks.forEach((s, i) => { if (s) { s.data.game = g; s.data.side = i; s.emit('game:start', { side: i, mode }); } });
  return g;
}
function resetPos(g) {
  g.p[0].x = M + 300; g.p[1].x = W - M - 300;
  g.p.forEach(p => { p.y = H / 2; p.vx = p.vy = 0; });
  Object.assign(g.b, { x: W / 2, y: H / 2, vx: 0, vy: 0 });
  g.pause = 1.2;
}
function kick(g, p, dx, dy, pw) {
  const b = g.b;
  if (Math.hypot(b.x - p.x, b.y - p.y) > p.r + b.r + 16) return false;
  const l = Math.hypot(dx, dy) || 1;
  b.vx = dx / l * pw; b.vy = dy / l * pw;
  return true;
}
function doKick(g, p, k) {
  if (g.pause > 0) return;
  const mv = p.jx || p.jy, dx = mv ? p.jx : p.fx, dy = mv ? p.jy : p.fy;
  if (k === 'S') kick(g, p, dx, dy, 760);
  else if (k === 'P') kick(g, p, dx, dy, 430);
  else if (k === 'T') kick(g, p, p.fx, p.fy, 600);
}
function doubleTouch(g, p) {
  const b = g.b;
  if (g.pause > 0 || p.dtCd > 0 || Math.hypot(b.x - p.x, b.y - p.y) > p.r + b.r + 30) return;
  p.dtCd = 2.5;
  b.vx = p.fx * 230; b.vy = p.fy * 230;
  setTimeout(() => {
    if (g.over) return;
    b.vx = p.fx * 330; b.vy = p.fy * 330;
    p.vx = p.fx * 420; p.vy = (p.fy + p.flS * .9) * 420;
  }, 150);
}
function bot(g, dt) {
  const a = g.p[1], b = g.b, lv = .85;
  a.run = false;
  const dx = b.x + 30 - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
  a.jx = dx / l * lv * .86; a.jy = dy / l * lv * .86;
  a.kc = Math.max(0, a.kc - dt);
  if (!a.kc && Math.hypot(b.x - a.x, b.y - a.y) < a.r + b.r + 14) { kick(g, a, M - b.x, H / 2 - b.y, 520 * lv); a.kc = .5; }
}
function step(g, dt) {
  const b = g.b;
  g.p.forEach(p => { p.dtCd = Math.max(0, p.dtCd - dt); });
  if (g.pause > 0) { g.pause -= dt; return; }
  g.t -= dt;
  if (g.t <= 0) return finish(g, 'time');
  if (g.mode === 'ai') bot(g, dt);
  for (const p of g.p) {
    const sp = 250 * (p.run && p.st > 0 ? 1.45 : 1);
    if (p.run && (p.jx || p.jy)) p.st = Math.max(0, p.st - 28 * dt); else p.st = Math.min(100, p.st + 14 * dt);
    const k = Math.min(1, dt * 9);
    p.vx += (p.jx * sp - p.vx) * k; p.vy += (p.jy * sp - p.vy) * k;
    if (p.jx || p.jy) { const l = Math.hypot(p.jx, p.jy); p.fx = p.jx / l; p.fy = p.jy / l; }
    p.x = Math.min(W - M, Math.max(M, p.x + p.vx * dt));
    p.y = Math.min(H - M, Math.max(M, p.y + p.vy * dt));
    const ex = b.x - p.x, ey = b.y - p.y, ed = Math.hypot(ex, ey), mn = p.r + b.r;
    if (ed < mn && ed > 0) {
      b.x = p.x + ex / ed * mn; b.y = p.y + ey / ed * mn;
      b.vx += p.vx * .35 + ex / ed * 60; b.vy += p.vy * .35 + ey / ed * 60;
    }
  }
  b.x += b.vx * dt; b.y += b.vy * dt;
  const f = Math.pow(.38, dt); b.vx *= f; b.vy *= f;
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
        sc: g.sc, t: Math.ceil(g.t), st: g.p.map(p => Math.round(p.st))
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
    const p = g.p[s.data.side];
    let jx = Number(d.jx) || 0, jy = Number(d.jy) || 0;
    const l = Math.hypot(jx, jy);
    if (l > 1) { jx /= l; jy /= l; }
    p.jx = jx; p.jy = jy;
    const now = Date.now();
    if (Math.abs(jy) > .75 && Math.abs(p.pjy) < .45) { p.flT = now; p.flS = jy < 0 ? -1 : 1; } // joystik tez tepaga/pastga
    p.pjy = jy;
    const run = !!d.run;
    if (run && !p.run && now - p.flT < 600) { doubleTouch(g, p); p.flT = 0; } // keyin Yugurish bosildi
    p.run = run;
  });
  s.on('act', d => {
    const g = s.data.game;
    if (g && !g.over && d && ['S', 'P', 'T'].includes(d.k)) doKick(g, g.p[s.data.side], d.k);
  });
  s.on('game:leave', () => leaveAll(s));
  s.on('disconnect', () => leaveAll(s));
});

server.listen(PORT, () => console.log('Server ishga tushdi: ' + PORT));
