# Authentication & Branch Management — Better Auth

Quick reference for authentication, organization (branch) management, and user profiles.

> **Stack:** Better Auth 1.5.6 with bearer tokens, organization plugin (branches = orgs), admin plugin.
> Auth routes are at `/api/auth/*` (managed by Better Auth). User CRUD is at `/api/v1/users/*`.

---

## Authentication Flow

```
1. Sign Up   → POST /api/auth/sign-up/email    (creates user + session)
2. Sign In   → POST /api/auth/sign-in/email    (returns bearer token)
3. Use API   → Include Authorization: Bearer <token> header
4. Session   → GET  /api/auth/get-session       (validate token, get user)
5. Sign Out  → POST /api/auth/sign-out          (invalidate session)
```

Better Auth manages sessions automatically — no manual token refresh needed.

---

## Auth Endpoints (Better Auth)

### Sign Up

```http
POST /api/auth/sign-up/email
Content-Type: application/json

{ "name": "John Doe", "email": "john@example.com", "password": "securePass123" }
```

**Response (200):**
```json
{
  "token": "session-token-string",
  "user": {
    "id": "user_id",
    "name": "John Doe",
    "email": "john@example.com",
    "emailVerified": false,
    "role": ["user"],
    "isActive": true,
    "createdAt": "2026-03-26T..."
  }
}
```

### Sign In

```http
POST /api/auth/sign-in/email
Content-Type: application/json

{ "email": "john@example.com", "password": "securePass123" }
```

**Response (200):** Same shape as sign-up.

### Get Session

```http
GET /api/auth/get-session
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "session": {
    "id": "session_id",
    "userId": "user_id",
    "token": "session-token",
    "expiresAt": "2026-04-02T...",
    "activeOrganizationId": "org_id_or_null"
  },
  "user": {
    "id": "user_id",
    "name": "John Doe",
    "email": "john@example.com",
    "role": ["user"],
    "isActive": true
  }
}
```

### Password Reset

```http
POST /api/auth/forget-password
Content-Type: application/json

{ "email": "john@example.com", "redirectTo": "https://yourapp.com/reset-password" }
```

User receives email with link. Then:

```http
POST /api/auth/reset-password
Content-Type: application/json

{ "token": "token-from-email", "newPassword": "newSecurePass456" }
```

### Change Password (authenticated)

```http
POST /api/auth/change-password
Authorization: Bearer <token>
Content-Type: application/json

{ "currentPassword": "oldPass", "newPassword": "newPass" }
```

### Sign Out

```http
POST /api/auth/sign-out
Authorization: Bearer <token>
```

### Health Check

```http
GET /api/auth/ok
→ { "ok": true }
```

---

## Organization (Branch) Endpoints

Branches are Better Auth organizations. Each branch has members with roles.

### List Organizations (branches user belongs to)

```http
GET /api/auth/organization/list
Authorization: Bearer <token>
```

**Response:** Array of organizations the user is a member of.

### Create Organization (branch)

```http
POST /api/auth/organization/create
Authorization: Bearer <token>
Content-Type: application/json

{ "name": "Dhaka Store", "slug": "dhaka-store" }
```

After creation, set branch metadata via the Branch API (`PATCH /api/v1/branches/:id`).

### Set Active Organization (switch branch)

```http
POST /api/auth/organization/set-active
Authorization: Bearer <token>
Content-Type: application/json

{ "organizationId": "org_id" }
```

This sets the active branch for the session. Subsequent API calls scoped by `x-organization-id` header will use this branch.

### Invite Member to Branch

```http
POST /api/auth/organization/invite-member
Authorization: Bearer <token>
Content-Type: application/json

{ "email": "staff@example.com", "role": "cashier" }
```

Sends invitation email. Invitee accepts at `/accept-invitation/:id`.

### List Members

```http
GET /api/auth/organization/list-members
Authorization: Bearer <token>
```

---

## User Profile Endpoints

### Get Profile

```http
GET /api/v1/users/me
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "user_id",
    "name": "John Doe",
    "email": "john@example.com",
    "role": ["user"],
    "phone": "+8801700000000",
    "isActive": true,
    "createdAt": "2026-01-15T..."
  }
}
```

### Update Profile

```http
PATCH /api/v1/users/me
Authorization: Bearer <token>
Content-Type: application/json

{ "name": "John Updated" }
```

### Branch List (via resource API)

```http
GET /api/v1/branches
Authorization: Bearer <token>
```

Returns all branches from the `organization` collection. Each branch has:
`_id`, `name`, `slug`, `code`, `branchType`, `branchRole`, `isDefault`, `isActive`

---

## Branch Scoping

All resource APIs (inventory, orders, transfers, POS) can be scoped to a branch:

```http
GET /api/v1/stock?limit=20
Authorization: Bearer <token>
x-organization-id: <branch_id>
```

The `x-organization-id` header tells the backend which branch to scope queries to.
Arc's `orgContext` middleware reads this and injects it into the request scope.

Superadmin users bypass branch scoping (elevation) and see all data.

---

## Roles

### System-Level Roles (user.role)

| Role | Description |
|------|-------------|
| `user` | Default role for customers |
| `admin` | Full system access |
| `superadmin` | Super administrator (bypasses branch scoping) |
| `finance-admin` | Finance admin |
| `finance-manager` | Financial operations |
| `store-manager` | Store management |
| `store-staff` | Store operations |
| `warehouse-admin` | Warehouse admin |
| `warehouse-staff` | Warehouse operations |

### Branch-Level Roles (organization member role)

| Role | Description |
|------|-------------|
| `branch_manager` | Full branch control |
| `inventory_staff` | Stock operations (receive, adjust, request) |
| `cashier` | POS operations only |
| `stock_receiver` | Receive transfers only |
| `stock_requester` | Request stock from head office |
| `viewer` | Read-only access |

---

## Environment Variables

### Backend (.env)

```env
BETTER_AUTH_SECRET=<min-32-chars>          # Required
BETTER_AUTH_URL=http://localhost:8050       # Backend URL
MONGO_URI=mongodb+srv://...               # MongoDB connection
FRONTEND_URL=http://localhost:3000         # For password reset emails
```

### Frontend (.env)

```env
BETTER_AUTH_SECRET=<same-as-backend>
NEXT_PUBLIC_API_URL=http://localhost:8050
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## Frontend Integration

### Better Auth Client (bearer token mode)

```typescript
// app/(auth)/_lib/client.ts
import { createAuthClient } from "better-auth/react";
import { organizationClient, adminClient } from "better-auth/client/plugins";

const TOKEN_KEY = "bigboss:auth-token";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  fetchOptions: {
    auth: { type: "Bearer", token: () => getAuthToken() ?? undefined },
    onSuccess(ctx) {
      const data = ctx.data as { session?: { token?: string } };
      if (data?.session?.token) setAuthToken(data.session.token);
    },
  },
  plugins: [adminClient(), organizationClient({ ac, roles: { ... } })],
});

// Sign in
await authClient.signIn.email({ email, password });

// Sign out
await authClient.signOut();

// Get session (React hook)
const { data: session } = useSession();

// List branches
const { data: orgs } = useListOrganizations();

// Switch branch
await authClient.organization.setActive({ organizationId: branchId });
```

### Commerce SDK (auto-injects bearer token)

```typescript
// components/providers/Providers.jsx
import { configureSDK } from "@classytic/commerce-sdk";
import { getAuthToken } from "@/app/(auth)/_lib/client";

configureSDK({
  baseUrl: process.env.NEXT_PUBLIC_API_URL,
  getToken: () => getAuthToken(),  // Auto-injected on every API call
});
```

All SDK API calls (products, orders, inventory, media, etc.) automatically include the bearer token. No explicit `token` parameter needed.

---

## TypeScript Types

```typescript
// User (from Better Auth + custom fields)
interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role?: string[];       // System-level roles
  phone?: string;
  isActive?: boolean;
  image?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Session
interface Session {
  session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: string;
    activeOrganizationId?: string;
  };
  user: User;
}

// System roles
type SystemRole = 'user' | 'admin' | 'superadmin' | 'finance-admin' | 'finance-manager'
  | 'store-manager' | 'store-staff' | 'warehouse-admin' | 'warehouse-staff';

// Branch roles (organization member roles)
type BranchRole = 'branch_manager' | 'inventory_staff' | 'cashier'
  | 'stock_receiver' | 'stock_requester' | 'viewer';
```

---

## Migration Scripts

```bash
# Migrate existing branches to BA organizations (preserves _id)
npm run migrate:branches

# Migrate existing users to BA (default password: bigboss@2026)
npm run migrate:users

# Seed fresh admin + branches (for new installs)
npm run seed:auth
```
