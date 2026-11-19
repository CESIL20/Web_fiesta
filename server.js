/**
 * Fiesta Restaurant — API de Gift Cards
 * Flujo:  POST /api/orders (PENDING_PAYMENT)
 *      -> admin verifica constancia -> POST /api/admin/orders/:id/confirm-payment (PAID + código de activación)
 *      -> cliente: POST /api/giftcards/activate {serial, code} (ACTIVE)
 *      -> local: POST /api/admin/giftcards/:serial/redeem (canje / saldo)
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // SQLite integrado en Node >= 22.13 (sin dependencias nativas)

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;
const CODE_SECRET = process.env.CODE_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!ADMIN_KEY || !CODE_SECRET) { console.error('Faltan ADMIN_KEY y/o CODE_SECRET en el entorno (.env).'); process.exit(1); }

// Debe coincidir con GC_AMOUNTS del front. El precio SIEMPRE se valida aquí, nunca se confía en el navegador.
const ALLOWED_AMOUNTS = [800, 1200, 2000, 3500, 5000];
const VENUES = ['lima', 'chiclayo'];
const VALID_MONTHS = 12, MAX_ATTEMPTS = 5, LOCK_MS = 15 * 60 * 1000;

const db = new DatabaseSync(process.env.DB_PATH || './giftcards.db');
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, customer TEXT NOT NULL, venue TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT', total INTEGER NOT NULL,
  created_at INTEGER NOT NULL, paid_at INTEGER
);
CREATE TABLE IF NOT EXISTS giftcards (
  serial TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  recipient TEXT NOT NULL, dedication TEXT, amount INTEGER NOT NULL, balance INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',  -- PENDING_PAYMENT | PAID | ACTIVE | EXHAUSTED | CANCELLED
  code_hash TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, paid_at INTEGER, activated_at INTEGER, expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, serial TEXT NOT NULL REFERENCES giftcards(serial),
  amount INTEGER NOT NULL, note TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_order ON giftcards(order_id);
`);

// ---------- utilidades ----------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rndChars = n => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const newSerial = () => `${rndChars(4)}-${rndChars(4)}-${rndChars(4)}-${rndChars(4)}`;
const newCode = () => `ACT-${rndChars(4)}-${rndChars(4)}`;
const normSerial = s => String(s || '').trim().toUpperCase();
const normCode = c => String(c || '').trim().toUpperCase();
const hashCode = c => crypto.createHmac('sha256', CODE_SECRET).update(normCode(c)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const now = () => Date.now();
const SERIAL_RE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;

const publicCard = c => ({
  serial: c.serial, recipient: c.recipient, dedication: c.dedication || '', amount: c.amount,
  balance: c.balance, status: c.status, expiresAt: c.expires_at
});

// Limitador simple en memoria (por IP). TODO(producción): usar Redis / express-rate-limit si hay varias instancias.
const hits = new Map();
const limit = (name, max, windowMs) => (req, res, next) => {
  const k = `${name}:${req.ip}`, t = now(), arr = (hits.get(k) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) return res.status(429).json({ error: 'Demasiados intentos. Intenta más tarde.' });
  arr.push(t); hits.set(k, arr); next();
};

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(cors({
  origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(new Error('Origen no permitido')),
  allowedHeaders: ['Content-Type', 'x-admin-key']
}));

const adminOnly = (req, res, next) => {
  const key = req.get('x-admin-key') || '';
  if (!safeEq(crypto.createHash('sha256').update(key).digest('hex'), crypto.createHash('sha256').update(ADMIN_KEY).digest('hex')))
    return res.status(401).json({ error: 'No autorizado' });
  next();
};

// ---------- PÚBLICO ----------
// 1) Crear pedido de Gift Cards (queda SIN ACTIVAR hasta confirmar el pago)
app.post('/api/orders', limit('orders', 20, 60 * 60 * 1000), (req, res) => {
  const customer = clean(req.body.customer, 80);
  const venue = String(req.body.venue || '');
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!customer) return res.status(400).json({ error: 'Falta el nombre del cliente' });
  if (!VENUES.includes(venue)) return res.status(400).json({ error: 'Sede inválida' });
  if (!items.length || items.length > 10) return res.status(400).json({ error: 'Items inválidos' });

  const parsed = [];
  for (const it of items) {
    const amount = Number(it.amount), qty = Number(it.qty), recipient = clean(it.recipient, 60);
    if (!ALLOWED_AMOUNTS.includes(amount)) return res.status(400).json({ error: `Monto no permitido: ${amount}` });
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) return res.status(400).json({ error: 'Cantidad inválida' });
    if (!recipient) return res.status(400).json({ error: 'Falta el nombre del agasajado' });
    parsed.push({ amount, qty, recipient, dedication: clean(it.dedication, 140) });
  }

  const orderId = `GC-${Date.now().toString(36).toUpperCase()}-${rndChars(3)}`;
  const cards = [];
  tx(() => {
    const total = parsed.reduce((s, i) => s + i.amount * i.qty, 0);
    db.prepare('INSERT INTO orders (id, customer, venue, total, created_at) VALUES (?,?,?,?,?)').run(orderId, customer, venue, total, now());
    const ins = db.prepare('INSERT INTO giftcards (serial, order_id, recipient, dedication, amount, balance, created_at) VALUES (?,?,?,?,?,?,?)');
    parsed.forEach((it, itemIndex) => {
      for (let q = 0; q < it.qty; q++) {
        const serial = newSerial();
        ins.run(serial, orderId, it.recipient, it.dedication, it.amount, it.amount, now());
        cards.push({ serial, itemIndex, recipient: it.recipient, amount: it.amount, status: 'PENDING_PAYMENT' });
      }
    });
  });
  res.status(201).json({ orderId, status: 'PENDING_PAYMENT', cards });
});

// 2) Verificación pública (QR): solo dice si es válida, sin exponer saldo ni datos personales
app.get('/api/giftcards/:serial', limit('verify', 60, 60 * 1000), (req, res) => {
  const c = db.prepare('SELECT * FROM giftcards WHERE serial = ?').get(normSerial(req.params.serial));
  if (!c) return res.status(404).json({ valid: false, status: 'NOT_FOUND' });
  const expired = c.expires_at && c.expires_at < now();
  res.json({ serial: c.serial, status: expired ? 'EXPIRED' : c.status, valid: c.status === 'ACTIVE' && !expired && c.balance > 0, expiresAt: c.expires_at });
});

// 3) Activación por el cliente: serie + código de activación
app.post('/api/giftcards/activate', limit('activate', 30, 60 * 60 * 1000), (req, res) => {
  const serial = normSerial(req.body.serial), code = normCode(req.body.code);
  if (!SERIAL_RE.test(serial) || !code) return res.status(400).json({ error: 'Serie o código con formato inválido' });
  const c = db.prepare('SELECT * FROM giftcards WHERE serial = ?').get(serial);
  const generic = { error: 'Serie o código de activación incorrectos' };
  if (!c) return res.status(400).json(generic);
  if (c.locked_until > now()) return res.status(429).json({ error: 'Gift Card bloqueada temporalmente por intentos fallidos. Intenta en 15 minutos.' });
  if (c.status === 'PENDING_PAYMENT') return res.status(409).json({ error: 'Tu pago aún no ha sido confirmado. Te enviaremos el código cuando se verifique.' });
  if (c.status === 'CANCELLED') return res.status(409).json({ error: 'Esta Gift Card fue cancelada.' });

  if (!c.code_hash || !safeEq(hashCode(code), c.code_hash)) {
    const fails = c.failed_attempts + 1;
    db.prepare('UPDATE giftcards SET failed_attempts = ?, locked_until = ? WHERE serial = ?').run(fails >= MAX_ATTEMPTS ? 0 : fails, fails >= MAX_ATTEMPTS ? now() + LOCK_MS : 0, serial);
    return res.status(400).json(generic);
  }
  if (c.status === 'PAID') {
    db.prepare("UPDATE giftcards SET status = 'ACTIVE', activated_at = ?, failed_attempts = 0 WHERE serial = ?").run(now(), serial);
  }
  const fresh = db.prepare('SELECT g.*, o.customer FROM giftcards g JOIN orders o ON o.id = g.order_id WHERE serial = ?').get(serial);
  res.json({ ...publicCard(fresh), buyer: fresh.customer, verifyUrl: `${PUBLIC_URL}/verificar/${serial}` });
});

// 4) Página de verificación a la que apunta el QR
app.get('/verificar/:serial', (req, res) => {
  const c = db.prepare('SELECT status, balance, expires_at FROM giftcards WHERE serial = ?').get(normSerial(req.params.serial));
  const expired = c && c.expires_at && c.expires_at < now();
  const ok = c && c.status === 'ACTIVE' && !expired && c.balance > 0;
  const msg = !c ? 'Gift Card no encontrada' : ok ? 'Gift Card VÁLIDA' : expired ? 'Gift Card VENCIDA' : c.status === 'EXHAUSTED' ? 'Gift Card sin saldo' : 'Gift Card NO VÁLIDA (sin activar)';
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verificación Gift Card</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0B0F;color:#fff;font-family:system-ui,sans-serif;text-align:center">
<div><div style="font-size:64px">${ok ? '✅' : '❌'}</div><h1 style="color:${ok ? '#C5A059' : '#ff8a8a'};font-size:24px">${msg}</h1><p style="color:#999">Fiesta Restaurant</p></div></body>`);
});

// ---------- ADMIN (restaurante) ----------
const cardsOf = orderId => db.prepare('SELECT * FROM giftcards WHERE order_id = ?').all(orderId).map(publicCard);

app.get('/api/admin/orders', adminOnly, (req, res) => {
  const status = req.query.status;
  const rows = status ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(String(status))
                      : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows.map(o => ({ ...o, cards: cardsOf(o.id) })));
});

// Confirmar pago -> genera el código de activación de cada tarjeta (se muestra UNA sola vez)
app.post('/api/admin/orders/:id/confirm-payment', adminOnly, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (o.status !== 'PENDING_PAYMENT') return res.status(409).json({ error: `El pedido ya está ${o.status}` });
  const expires = new Date(); expires.setMonth(expires.getMonth() + VALID_MONTHS);
  const codes = [];
  tx(() => {
    db.prepare("UPDATE orders SET status = 'PAID', paid_at = ? WHERE id = ?").run(now(), o.id);
    const upd = db.prepare("UPDATE giftcards SET status = 'PAID', code_hash = ?, paid_at = ?, expires_at = ? WHERE serial = ?");
    for (const c of db.prepare('SELECT serial, recipient, amount FROM giftcards WHERE order_id = ?').all(o.id)) {
      const code = newCode();
      upd.run(hashCode(code), now(), expires.getTime(), c.serial);
      codes.push({ serial: c.serial, recipient: c.recipient, amount: c.amount, activationCode: code });
    }
  });
  const whatsappText = [`¡Hola ${o.customer}! Confirmamos tu pago ✅`, `Pedido ${o.id}`, '',
    ...codes.map(c => `🎁 Gift Card para ${c.recipient} (S/ ${c.amount})\nSerie: ${c.serial}\nCódigo de activación: ${c.activationCode}`), '',
    'Actívala en nuestra web (sección Gift Cards → "Activar Gift Card").'].join('\n');
  res.json({ orderId: o.id, customer: o.customer, codes, whatsappText });
});

app.post('/api/admin/orders/:id/cancel', adminOnly, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido no encontrado' });
  tx(() => {
    db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE id = ?").run(o.id);
    db.prepare("UPDATE giftcards SET status = 'CANCELLED' WHERE order_id = ?").run(o.id);
  });
  res.json({ ok: true });
});

app.get('/api/admin/giftcards/:serial', adminOnly, (req, res) => {
  const c = db.prepare('SELECT * FROM giftcards WHERE serial = ?').get(normSerial(req.params.serial));
  if (!c) return res.status(404).json({ error: 'Serie no encontrada' });
  res.json({ ...publicCard(c), orderId: c.order_id, redemptions: db.prepare('SELECT amount, note, created_at FROM redemptions WHERE serial = ? ORDER BY id').all(c.serial) });
});

// Canje en el local (total o parcial)
app.post('/api/admin/giftcards/:serial/redeem', adminOnly, (req, res) => {
  const serial = normSerial(req.params.serial), amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Monto inválido' });
  try {
    const out = tx(() => {
      const c = db.prepare('SELECT * FROM giftcards WHERE serial = ?').get(serial);
      if (!c) throw Object.assign(new Error('Serie no encontrada'), { code: 404 });
      if (c.status !== 'ACTIVE') throw Object.assign(new Error(`Gift Card no válida (estado ${c.status})`), { code: 409 });
      if (c.expires_at && c.expires_at < now()) throw Object.assign(new Error('Gift Card vencida'), { code: 409 });
      if (amount > c.balance) throw Object.assign(new Error(`Saldo insuficiente (saldo S/ ${c.balance})`), { code: 409 });
      const balance = c.balance - amount;
      db.prepare('UPDATE giftcards SET balance = ?, status = ? WHERE serial = ?').run(balance, balance === 0 ? 'EXHAUSTED' : 'ACTIVE', serial);
      db.prepare('INSERT INTO redemptions (serial, amount, note, created_at) VALUES (?,?,?,?)').run(serial, amount, clean(req.body.note, 120), now());
      return { serial, redeemed: amount, balance };
    });
    res.json(out);
  } catch (e) { res.status(e.code || 500).json({ error: e.message }); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/health', (req, res) => res.json({ ok: true }));
app.use((err, req, res, next) => res.status(err.message === 'Origen no permitido' ? 403 : 500).json({ error: err.message }));

if (require.main === module) app.listen(PORT, () => console.log(`Fiesta Gift Card API en ${PUBLIC_URL} (admin: ${PUBLIC_URL}/admin)`));
module.exports = app;
