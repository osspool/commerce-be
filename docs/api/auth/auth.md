# Authentication API Guide

Quick reference for implementing authentication, user registration, and profile management.

> **Architecture Note:** User model handles auth only (email, password, roles). Profile data (addresses, phone) lives in Customer model. On registration, user is auto-linked to existing Customer (by email) or a new one is created.

---

## Authentication Flow

```
1. Register  → POST /api/v1/auth/register (creates user + customer)
2. Login     → POST /api/v1/auth/login (returns JWT tokens)
3. Use API   → Include Authorization: Bearer <token> header
4. Refresh   → POST /api/v1/auth/refresh (when token expires)
```

---

## Public Endpoints

### Register

```http
POST /api/v1/auth/register
```

**Request:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "securePass123"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "User registered successfully"
}
```

**Validation:**
| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Min 1 character |
| `email` | Yes | Valid email format |
| `password` | Yes | Min 6 characters |

**Errors:**
| Status | Message |
|--------|---------|
| 400 | User already exists |

---

### Login

```http
POST /api/v1/auth/login
```

**Request:**
```json
{
  "email": "john@example.com",
  "password": "securePass123"
}
```

**Response (200):**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "user_id",
    "name": "John Doe",
    "email": "john@example.com",
    "roles": ["user"],
    "branch": {
      "branchId": "branch_id",
      "branchCode": "HQ",
      "branchName": "Head Office",
      "branchRole": "head_office",
      "roles": ["branch_manager"]
    },
    "branchIds": ["branch_id"],
    "branches": [...],
    "isAdmin": false,
    "isWarehouseStaff": false
  }
}
```

**Errors:**
| Status | Message |
|--------|---------|
| 401 | Invalid email or password |
| 401 | Account is disabled |

---

### Refresh Token

```http
POST /api/v1/auth/refresh
```

**Request:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response (200):**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Errors:**
| Status | Message |
|--------|---------|
| 401 | Refresh token required |
| 401 | Invalid or expired refresh token |
| 401 | Account is disabled |

---

### Forgot Password

```http
POST /api/v1/auth/forgot-password
```

**Request:**
```json
{
  "email": "john@example.com"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Password reset email sent"
}
```

**Notes:**
- Sends email with reset link: `{FRONTEND_URL}/reset-password?token=xxx`
- Token expires in 1 hour

**Errors:**
| Status | Message |
|--------|---------|
| 404 | User not found |

---

### Reset Password

```http
POST /api/v1/auth/reset-password
```

**Request:**
```json
{
  "token": "abc123...",
  "newPassword": "newSecurePass456"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Password has been reset"
}
```

**Validation:**
| Field | Required | Notes |
|-------|----------|-------|
| `token` | Yes | From reset email |
| `newPassword` | Yes | Min 6 characters |

**Errors:**
| Status | Message |
|--------|---------|
| 400 | Invalid or expired token |

---

## Authenticated Endpoints

All endpoints below require: `Authorization: Bearer <token>`

---

### Get Current User Profile

```http
GET /api/v1/users/me
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "user_id",
    "name": "John Doe",
    "email": "john@example.com",
    "roles": ["user"],
    "isActive": true,
    "lastLoginAt": "2025-12-21T10:00:00.000Z",
    "createdAt": "2025-01-15T08:30:00.000Z"
  }
}
```

---

### Update Current User Profile

```http
PATCH /api/v1/users/me
Authorization: Bearer <token>
```

**Request:**
```json
{
  "name": "John Updated",
  "email": "john.new@example.com"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "User updated successfully",
  "data": {
    "id": "user_id",
    "name": "John Updated",
    "email": "john.new@example.com",
    "roles": ["user"]
  }
}
```

**Allowed Fields:**
| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Min 1 character |
| `email` | string | Valid email format |

> **Note:** For addresses and phone, use the Customer API.

**Errors:**
| Status | Message |
|--------|---------|
| 400 | Email already exists |
| 400 | Validation error |

---

### Get User Organizations

```http
GET /api/v1/auth/organizations
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "data": [...]
}
```

---

## Token Management

### JWT Token Structure

The access token contains:
```json
{
  "id": "user_id",
  "name": "John Doe",
  "email": "john@example.com",
  "roles": ["user"],
  "organizations": []
}
```

### Token Expiry

- **Access Token:** Configured via `JWT_EXPIRES_IN` env variable
- **Refresh Token:** Configured via `JWT_REFRESH_EXPIRES_IN` env variable

### Frontend Implementation

```javascript
// Store tokens after login
const { token, refreshToken } = await login(email, password);
localStorage.setItem('token', token);
localStorage.setItem('refreshToken', refreshToken);

// Use token in requests
const headers = {
  'Authorization': `Bearer ${localStorage.getItem('token')}`,
  'Content-Type': 'application/json'
};

// Refresh when token expires (401 response)
async function refreshAccessToken() {
  const response = await fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: localStorage.getItem('refreshToken') })
  });

  if (response.ok) {
    const { token, refreshToken } = await response.json();
    localStorage.setItem('token', token);
    localStorage.setItem('refreshToken', refreshToken);
    return token;
  }

  // Refresh failed - redirect to login
  localStorage.clear();
  window.location.href = '/login';
}
```

---

## User Roles

### System-Level Roles

| Role | Description |
|------|-------------|
| `user` | Default role for customers |
| `admin` | Full system access |
| `superadmin` | Super administrator |
| `finance-admin` | Finance admin (approvals, reporting, adjustments) |
| `finance-manager` | Financial operations |
| `store-manager` | Store management |
| `warehouse-admin` | Warehouse admin (transfers, purchasing, approvals) |
| `warehouse-staff` | Warehouse operations |

### Branch-Level Roles

| Role | Key | Description |
|------|-----|-------------|
| Branch Manager | `branch_manager` | Full branch control |
| Inventory Staff | `inventory_staff` | Stock operations (receive, adjust, request) |
| Cashier | `cashier` | POS operations only |
| Stock Receiver | `stock_receiver` | Receive transfers only |
| Stock Requester | `stock_requester` | Can request stock from head office |
| Viewer | `viewer` | Read-only access |

---

## TypeScript Types

```typescript
// Login request
interface LoginRequest {
  email: string;
  password: string;
}

// Login response
interface LoginResponse {
  success: true;
  token: string;
  refreshToken: string;
  user: {
    id: string;
    name: string;
    email: string;
    roles: string[];
    branch?: {
      branchId: string;
      branchCode: string;
      branchName: string;
      branchRole: 'head_office' | 'sub_branch';
      roles: string[];
    };
    branchIds: string[];
    branches: BranchAssignment[];
    isAdmin: boolean;
    isWarehouseStaff: boolean;
  };
}

// Register request
interface RegisterRequest {
  name: string;
  email: string;
  password: string;
}

// User profile
interface UserProfile {
  id: string;
  name: string;
  email: string;
  roles: string[];
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

// Update profile request
interface UpdateProfileRequest {
  name?: string;
  email?: string;
}

// Branch assignment
interface BranchAssignment {
  branchId: string;
  branchCode: string;
  branchName: string;
  branchRole: 'head_office' | 'sub_branch';
  roles: string[];
  isPrimary: boolean;
  assignedAt: string;
}

// System roles
type SystemRole = 'user' | 'admin' | 'superadmin' | 'finance-admin' | 'finance-manager' | 'store-manager' | 'warehouse-admin' | 'warehouse-staff';

// Branch roles
type BranchRole = 'branch_manager' | 'inventory_staff' | 'cashier' | 'stock_receiver' | 'stock_requester' | 'viewer';
```

---

## Error Response Shape

All error responses follow this format:

```json
{
  "success": false,
  "message": "Error description"
}
```

For validation errors:
```json
{
  "success": false,
  "message": "Validation error",
  "errors": ["Email is required", "Password must be at least 6 characters"]
}
```

---

## Complete Flow Example

**1. Register a new user:**
```javascript
const registerResponse = await fetch('/api/v1/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Jane Smith',
    email: 'jane@example.com',
    password: 'securePass123'
  })
});
// { success: true, message: "User registered successfully" }
```

**2. Login:**
```javascript
const loginResponse = await fetch('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'jane@example.com',
    password: 'securePass123'
  })
});
const { token, refreshToken, user } = await loginResponse.json();

// Store tokens
localStorage.setItem('token', token);
localStorage.setItem('refreshToken', refreshToken);
```

**3. Get profile:**
```javascript
const profileResponse = await fetch('/api/v1/users/me', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const { data: profile } = await profileResponse.json();
```

**4. Update profile:**
```javascript
const updateResponse = await fetch('/api/v1/users/me', {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ name: 'Jane Updated' })
});
```

**5. Password reset flow:**
```javascript
// Request reset email
await fetch('/api/v1/auth/forgot-password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'jane@example.com' })
});

// User clicks link in email, then:
await fetch('/api/v1/auth/reset-password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: 'token_from_email_link',
    newPassword: 'newSecurePass456'
  })
});
```
