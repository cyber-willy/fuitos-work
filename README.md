# Fuitos Work

Fuitos Work is a full-stack employee task and performance management platform for internal company operations. It includes secure authentication, role-based access control, task lifecycle management, notifications, analytics, and a responsive dashboard.

## Product Overview

The platform is designed for:

- Super admins managing company-wide operations
- Managers coordinating teams and approvals
- Employees tracking tasks and submitting completion notes
- Teams monitoring deadlines, workload, and performance metrics

## Architecture

- Backend: Node.js + Express
- Database: SQL.js-compatible SQLite runtime for local portability and native-build-free execution
- Authentication: JWT-based API access with bcrypt password hashing
- Frontend: Responsive single-page app served from Express static files
- Security: Helmet, CORS, rate limiting, secure validation, protected endpoints

## Features

- User authentication and session-based JWT access
- Role-based authorization for admin, manager, and employee
- Employee and department management
- Task creation, assignment, approval, rejection, and comments
- Dashboard metrics and analytics
- Notification center
- Audit logging for important actions
- Demo seed data to evaluate the full workflow immediately

## Local Setup

1. Install Node.js 20+.
2. Clone or open the project folder.
3. Create a local environment file:

   copy .env.example .env

4. Install dependencies:

   npm install

5. Run the app:

   node server.js

   or

   npm start

6. Open the UI in a browser:

   http://localhost:3000

> The app is currently configured to run with SQL.js, which avoids native SQLite build issues on Windows environments.

## Demo Credentials

- Admin: admin@fuitos.com / Admin@123
- Manager: manager1@fuitos.com / Manager@123
- Employee: liam@fuitos.com / Employee@123

## API Overview

Key routes include:

- POST /api/auth/login
- POST /api/auth/register
- GET /api/users
- GET /api/tasks
- POST /api/tasks
- POST /api/tasks/:id/start
- POST /api/tasks/:id/submit
- POST /api/tasks/:id/approve
- POST /api/tasks/:id/reject
- GET /api/notifications
- GET /api/dashboard/overview
- GET /api/analytics
- GET /api/audit-logs

## Database Structure

The app uses an in-memory SQLite-compatible schema for:

- users
- roles
- permissions
- departments
- teams
- tasks
- task_assignments
- task_comments
- task_attachments
- task_activity
- notifications
- audit_logs
- sessions
- password_resets

## Deployment Notes

- Set a strong JWT secret in .env.
- Keep the app behind a reverse proxy or managed host in production.
- Use environment-specific configurations for production.
- Restrict file upload extensions to the approved list.
- Add a real email provider to support password reset flows when needed.
- For production deployments, use PostgreSQL via DATABASE_URL with a persistent free-tier provider.
- Repository-side deployment preparation is included in PRODUCTION.md and DEPLOYMENT.md.

## Security Notes

- Passwords are never stored in plain text.
- Sensitive routes require JWT authentication.
- Client-side checks are not a substitute for server-side authorization.
- File uploads are restricted to business-safe formats.
