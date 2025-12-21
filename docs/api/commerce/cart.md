# Cart API Guide (Frontend)

Concise integration notes for add/update/remove cart in UI.

## Auth & Base
- Auth required: `Authorization: Bearer <token>` (user or admin).
- Base path: `/api/v1/cart`.
- UX rule: if unauthenticated, prompt login → on success retry intended cart action; if authenticated, call directly and refresh cart badge/mini-cart with returned payload.

## Endpoints
- `GET /api/v1/cart` — Get (or auto-create) current user cart.
- `POST /api/v1/cart/items` — Add item.
- `PATCH /api/v1/cart/items/:itemId` — Update quantity.
- `DELETE /api/v1/cart/items/:itemId` — Remove item.
- `DELETE /api/v1/cart` — Clear all items.

## Request Shapes
- Add item (`POST /items`): `{ productId: string (req), quantity: number>=1 (req), variantSku?: string }`
- Update qty (`PATCH /items/:itemId`): `{ quantity: number>=1 }`
- Remove item (`DELETE /items/:itemId`): no body.
- Clear cart (`DELETE /`): no body.

## Success Response Shape (all endpoints)
- Status `200`.
- Body: `{ success: true, data: { _id, user, items: [{ _id, product:{ name, slug, images, variants, discount, basePrice }, variantSku, quantity }], createdAt, updatedAt } }`
- Use returned `itemId` (`items[i]._id`) for subsequent update/remove; always render from `data`.

## Error Shape
- Status `400` or `500`.
- Body: `{ success: false, message: "<reason>" }`
- Common causes: product not found, invalid variation/option, insufficient quantity, cart/item not found.

## UI Tips
- Block double-click while waiting; show toast on success/error.
- After any mutation, rely on returned cart payload to refresh UI (badge, mini-cart).
- Store last attempted action so you can retry post-login seamlessly.

