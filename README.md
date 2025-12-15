# Fitverse Backend

> Enterprise-grade fitness management platform built with Node.js, Fastify, and MongoDB

Amazon: "Two-pizza teams" build focused features
Google: Monorepo with shared code, but no premature libraries
Meta: "Move fast" - Don't abstract until you're sure of the pattern

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Start development server
npm run dev

# Run tests
npm test
```

## 📋 Features

- **Multi-tenant Architecture**: Organization-scoped data with flexible permissions
- **HRM System**: Employee management, payroll, attendance tracking
- **Membership Management**: Gym memberships with subscription handling
- **Transaction System**: Payment processing with validation and hooks
- **Monetization Library**: Subscription and one-time purchase support
- **Attendance Library**: Smart check-in/out with overtime detection
- **Flexible Querying**: Advanced filtering, sorting, and pagination
- **Security-First**: Field-level filtering, guards, and validation

## 📚 Documentation

Comprehensive documentation is organized in the [`docs/`](./docs/) directory:

- **[API Guide](./docs/api/API_GUIDE.md)** - API endpoints and usage
- **[Architecture](./docs/architecture/ARCHITECTURE.md)** - System design and patterns
- **[Flexible Querying](./docs/guides/FLEXIBLE_QUERYING_GUIDE.md)** - Query system guide

### Component Documentation

- [Guards](./common/guards/README.md) - Authorization patterns
- [Plugins](./common/plugins/README.md) - Fastify plugins
- [Repositories](./common/repositories/README.md) - Data access layer
- [Permissions](./config/PERMISSIONS_GUIDE.md) - Permission system

## 🏗️ Architecture

```
fitverse-be/
├── common/              # Shared components
│   ├── guards/         # Authorization guards
│   ├── controllers/    # Base controllers
│   ├── repositories/   # Data access layer
│   ├── middleware/     # Request middleware
│   └── plugins/        # Fastify plugins
├── modules/            # Business modules
│   ├── organization/   # Multi-tenant organizations
│   ├── employee/       # HR management
│   ├── customer/       # Customer profiles
│   ├── gym-plan/       # Service offerings
│   ├── membership/     # Gym memberships
│   └── transaction/    # Payment handling
├── lib/                # Reusable libraries
│   ├── attendance/     # Attendance system
│   ├── monetization/   # Subscription engine
│   └── payment/        # Payment processing
└── docs/               # Documentation
```

## 🔧 Tech Stack

- **Runtime**: Node.js 22+
- **Framework**: Fastify 5.x
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT with fastify-jwt
- **Validation**: Mongoose schemas + custom validators
- **Testing**: (TBD)

## 🛠️ Development

### Project Structure

Each module follows a consistent pattern:

```
modules/example/
├── example.model.js        # Mongoose model
├── example.repository.js   # Data access
├── example.controller.js   # Request handlers
├── example.plugin.js       # Route registration
├── example.presets.js      # Middleware presets
└── schemas.js             # API schemas
```

### Common Patterns

**Repository Pattern**:
```javascript
import { Repository, organizationScopePlugin } from '#common/repositories';

class ExampleRepository extends Repository {
  constructor() {
    super(ExampleModel, [organizationScopePlugin()]);
  }
}
```

**Guard Usage**:
```javascript
import { ownershipGuard } from '#common/guards';

middlewares: {
  update: [
    ownershipGuard({ Model, orgField: 'organizationId' })
  ]
}
```

**Field Protection** (use schema-level validation):
```javascript
// In schemas.js
export const schemaOptions = {
  strictAdditionalProperties: true, // Reject unknown fields
  fieldRules: {
    protectedField: { systemManaged: true }, // Omit from create/update
    organizationId: { immutable: true }, // Omit from update only
  }
};
```

**Controller Pattern**:
```javascript
import BaseController from '#common/controllers/baseController.js';

class ExampleController extends BaseController {
  constructor() {
    super(exampleRepository, exampleSchemaOptions);
  }
}
```

## 📦 Scripts

```bash
# Development
npm run dev          # Start dev server with hot reload
npm run dev:debug    # Start with debugger

# Production
npm start            # Start production server

# Testing
npm test             # Run tests
npm run test:watch   # Run tests in watch mode

# Code Quality
npm run lint         # Check code style
npm run format       # Format code
```

## 🔒 Security

- **Field-level security**: Automatic filtering of sensitive fields
- **Organization scoping**: Multi-tenant data isolation
- **Guard system**: Authorization at route level
- **Input validation**: Schema-based validation
- **Secure defaults**: Whitelist-only populate and filtering

## 🌍 Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=development

# Database
MONGODB_URI=mongodb://localhost:27017/fitverse

# Authentication
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d

# See .env.example for complete list
```

## 🤝 Contributing

1. Follow the existing code patterns
2. Add tests for new features
3. Update documentation
4. Keep commits atomic and descriptive

## 📝 Common Errors

**package.json BOM Error**:
```bash
# Check for BOM (Byte Order Mark)
node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8')); console.log('✓ package.json is valid and has no BOM!')"
```

## 📄 License

MIT

---

**Built with ❤️ by AlgoClan**
