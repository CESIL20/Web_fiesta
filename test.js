// Prueba de extremo a extremo del flujo: node test.js
process.env.ADMIN_KEY = 'admin-test'; process.env.CODE_SECRET = 'secreto-test'; process.env.DB_PATH = ':memory:';
const assert = require('assert');
const app = require('./server');
const server = app.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, body, admin) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-admin-key': 'admin-test' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  try {
    // 1) Pedido: precio inválido rechazado
    assert.strictEqual((await call('POST', '/api/orders', { customer: 'Andy', venue: 'lima', items: [{ recipient: 'Ana', amount: 1, qty: 1 }] })).status, 400);
    // 2) Pedido válido: 2 tarjetas
    const o = await call('POST', '/api/orders', { customer: 'Andy', venue: 'lima', items: [{ recipient: 'Ana', dedication: 'Feliz cumple', amount: 800, qty: 2 }] });
    assert.strictEqual(o.status, 201); assert.strictEqual(o.data.cards.length, 2);
    const [c1, c2] = o.data.cards;
    // 3) Sin pago confirmado no se puede activar y no es válida
    assert.strictEqual((await call('POST', '/api/giftcards/activate', { serial: c1.serial, code: 'ACT-AAAA-BBBB' })).status, 409);
    assert.strictEqual((await call('GET', `/api/giftcards/${c1.serial}`)).data.valid, false);
    // 4) Admin sin clave: rechazado
    assert.strictEqual((await call('POST', `/api/admin/orders/${o.data.orderId}/confirm-payment`)).status, 401);
    // 5) Confirmar pago: genera códigos
    const p = await call('POST', `/api/admin/orders/${o.data.orderId}/confirm-payment`, null, true);
    assert.strictEqual(p.status, 200); const code1 = p.data.codes.find(c => c.serial === c1.serial).activationCode;
    assert.ok(/^ACT-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code1));
    assert.strictEqual((await call('POST', `/api/admin/orders/${o.data.orderId}/confirm-payment`, null, true)).status, 409);
    // 6) Código incorrecto x5 => bloqueo
    for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', '/api/giftcards/activate', { serial: c2.serial, code: 'ACT-ZZZZ-ZZZZ' })).status, 400);
    assert.strictEqual((await call('POST', '/api/giftcards/activate', { serial: c2.serial, code: p.data.codes.find(c => c.serial === c2.serial).activationCode })).status, 429);
    // 7) Activación correcta
    const a = await call('POST', '/api/giftcards/activate', { serial: c1.serial.toLowerCase(), code: code1.toLowerCase() });
    assert.strictEqual(a.status, 200); assert.strictEqual(a.data.status, 'ACTIVE'); assert.strictEqual(a.data.buyer, 'Andy');
    assert.strictEqual((await call('GET', `/api/giftcards/${c1.serial}`)).data.valid, true);
    // 8) Canje parcial y saldo insuficiente
    assert.strictEqual((await call('POST', `/api/admin/giftcards/${c1.serial}/redeem`, { amount: 300 }, true)).data.balance, 500);
    assert.strictEqual((await call('POST', `/api/admin/giftcards/${c1.serial}/redeem`, { amount: 600 }, true)).status, 409);
    assert.strictEqual((await call('POST', `/api/admin/giftcards/${c1.serial}/redeem`, { amount: 500 }, true)).data.balance, 0);
    assert.strictEqual((await call('GET', `/api/giftcards/${c1.serial}`)).data.valid, false);
    console.log('✅ Todas las pruebas de la API pasaron');
  } catch (e) { console.error('❌', e.message); process.exitCode = 1; }
  server.close();
});
