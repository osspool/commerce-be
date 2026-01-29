# Classytic Commerce Backend

Production-ready e-commerce backend built with Arc Framework (Fastify + MongoDB).

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your configuration

# Validate environment
npm run validate:env

# Run development server
npm run dev

# Run production server
npm run start
```

## Documentation

- **Arc Framework Usage**: [ARC_USAGE.md](ARC_USAGE.md)
- **Arc Framework API**: [packages/arc/README.md](packages/arc/README.md)
- **Production Features**: [PRODUCTION_FEATURES.md](PRODUCTION_FEATURES.md) - Meta/Stripe tier features

## Project Structure

```
be-prod/
├── config/               # Configuration and validation
├── lib/                  # Utilities (memory, helpers)
├── modules/              # Business modules (catalog, sales, etc.)
├── packages/arc/         # Arc framework package
├── routes/               # API route registration
├── index.js              # Application entry (Arc createApp)
└── index.factory.js      # Factory utilities / serverless exports
```

## Available Scripts

```bash
npm run dev              # Development with watch
npm run dev:factory      # Development with factory utilities
npm run start            # Production server
npm run start:factory    # Production with factory utilities
npm run validate:env     # Validate environment variables
npm run memory:check     # Check memory usage
arc introspect           # Show registered resources
arc docs                 # Export OpenAPI spec
```

## Environment Variables

**Required:**
- `JWT_SECRET` - JWT signing secret (min 32 chars)
- `MONGO_URI` - MongoDB connection string

**Production Required:**
- `CORS_ORIGIN` - Allowed CORS origins
- `JWT_REFRESH_SECRET` - Refresh token secret
- `SESSION_SECRET` - Session secret
- `COOKIE_SECRET` - Cookie signing secret

**Optional:**
- `PORT` - Server port (default: 8040)
- `NODE_ENV` - Environment (production/development)

## CLI Commands

```bash
# Generate new resource
arc generate resource product --module catalog --presets softDelete,slugLookup

# Show all resources
arc introspect

# Export API documentation
arc docs ./docs/openapi.json
```

## Features

### Core Framework
- **Arc Framework** - Resource-oriented backend framework
- **Opt-out Security** - Helmet, CORS, rate limiting enabled by default
- **Environment Validation** - Fail-fast with clear error messages
- **Memory Management** - Built-in monitoring and leak detection
- **Brotli Compression** - 20-30% better than gzip
- **OpenAPI Export** - Auto-generate API documentation
- **CLI Generator** - Scaffold resources quickly
- **Serverless Ready** - AWS Lambda, Cloud Run, Vercel support
- **Testing Utilities** - Mock factories, test DB helpers
- **Type Safety** - Full TypeScript support

### Production Features (Meta/Stripe Tier)
- **OpenTelemetry Tracing** - Distributed tracing with Jaeger/Zipkin/DataDog
- **Enhanced Health Checks** - Kubernetes liveness/readiness + Prometheus metrics
- **Circuit Breaker** - Prevent cascading failures for external APIs
- **Schema Migrations** - Database schema versioning with rollback support

## Architecture

- **Framework**: Fastify + Arc
- **Database**: MongoDB + Mongoose
- **Auth**: JWT with refresh tokens
- **Validation**: Joi/Zod schemas
- **Testing**: Vitest
- **Code Generation**: Arc CLI

## License

MIT
