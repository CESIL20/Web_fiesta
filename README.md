# Fiesta — API de Gift Cards

Flujo: **pedido (sin activar) → verificas el pago → código de activación → el cliente activa → canje en el local**.

## Instalación (Node ≥ 22.13)
```bash
cd giftcard-api && npm install
cp .env.example .env      # edita ADMIN_KEY, CODE_SECRET, ALLOWED_ORIGINS, PUBLIC_URL
node --env-file=.env server.js
npm test                  # prueba el flujo completo
```
Panel del restaurante: `https://TU-API/admin`.

## Endpoints
| Método | Ruta | Quién | Qué hace |
|---|---|---|---|
| POST | `/api/orders` | Web | Crea el pedido; las tarjetas quedan `PENDING_PAYMENT` |
| POST | `/api/giftcards/activate` | Cliente | `{serial, code}` → `ACTIVE` (5 fallos = bloqueo 15 min) |
| GET | `/api/giftcards/:serial` | Público/QR | Solo `valid` y estado, sin saldo |
| GET | `/verificar/:serial` | QR | Página ✅/❌ |
| GET | `/api/admin/orders?status=` | Admin | Lista pedidos |
| POST | `/api/admin/orders/:id/confirm-payment` | Admin | Genera códigos (se muestran una vez) |
| POST | `/api/admin/orders/:id/cancel` | Admin | Cancela pedido y tarjetas |
| GET | `/api/admin/giftcards/:serial` | Admin | Saldo e historial |
| POST | `/api/admin/giftcards/:serial/redeem` | Admin | Canje total o parcial |

Admin = cabecera `x-admin-key`. Los códigos se guardan **hasheados** (HMAC) y los montos se validan en el servidor.

## Producción
- Sirve la API por **HTTPS** y respalda `giftcards.db`.
- Pon `ALLOWED_ORIGINS` con tu dominio de GitHub Pages.
- TODO: limitador con Redis si usas varias instancias; envío automático del código por WhatsApp Business API / correo.
