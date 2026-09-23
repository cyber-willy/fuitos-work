# Fuitos Work Production Readiness

## Overview

Fuitos Work is an internal employee task and performance management platform. This repository is prepared for a free-tier production deployment model with PostgreSQL persistence and a Node.js hosting service.

## Architecture

- Application: Node.js + Express
- Frontend: static single-page app
- Auth: JWT + bcryptjs
- Database: PostgreSQL in production, local SQLite-compatible runtime for development
- File storage: local uploads in development; persistent object storage recommended in production
- Monitoring: /health and /health/ready for uptime checks
- Hosting target: free-tier Node host such as Render or Railway

## Environment Variables

Required values:

- NODE_ENV
- PORT
- APP_NAME
- APP_URL
- CORS_ORIGIN
- DATABASE_URL
- JWT_SECRET
- UPLOAD_PATH
- SMTP_HOST
- SMTP_PORT
- SMTP_USER
- SMTP_PASSWORD
- STORAGE_URL
- STORAGE_KEY

Do not commit actual secrets. Use your hosting provider's environment variable manager.

## Production Database

The project is prepared for PostgreSQL via the DATABASE_URL environment variable. The schema is represented in migrations/001_initial_schema.sql and can be used as the starting point for a managed PostgreSQL database.

## Health Checks

The application exposes:

- /api/health
- /health
- /health/ready

These endpoints should be used by a free uptime checker or hosting provider health monitoring.

## Security Review

The app already includes:

- JWT authentication
- bcrypt password hashing
- protected routes
- Helmet security headers
- rate limiting
- file upload restrictions
- server-side authorization checks

The repository-side hardening work is complete enough to support a hosted production deployment once the external provider credentials are supplied.

## Deployment Notes

- Use a free-tier PostgreSQL provider such as Supabase or Neon.
- Use a free-tier Node host such as Render.
- Configure HTTPS automatically through the hosting provider.
- Store all secrets in the provider's environment manager.
- Keep the app internal and protect endpoints with authentication.

## Backup and Restore

Production backups should be handled by the selected PostgreSQL provider. If automatic backups are unavailable on the free tier, use the provider's manual export and restore flow and document the process.

## Known Limitation

The application is repository-ready for deployment, but the actual external database and hosting accounts are still required before a production URL can be created.
