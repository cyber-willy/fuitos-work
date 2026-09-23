# Fuitos Work Deployment Runbook

## Goal

Deploy the application to a free hosting provider using PostgreSQL and HTTPS, while keeping internal access controlled and production-ready.

## Step 1: Create a PostgreSQL free-tier database

Choose a free-tier PostgreSQL provider such as Supabase or Neon.

Required values after creation:

- DATABASE_URL
- database host
- database username/password if needed

## Step 2: Create the hosting project

Choose a free-tier Node host such as Render.

Create the project and connect the GitHub repository.

## Step 3: Add environment variables

Add the following variables in the host environment manager:

- NODE_ENV=production
- PORT=10000
- APP_NAME=Fuitos Work
- APP_URL=https://<your-host-url>
- CORS_ORIGIN=https://<your-host-url>
- DATABASE_URL=<postgres-url>
- JWT_SECRET=<strong-random-secret>
- UPLOAD_PATH=./uploads
- SMTP_HOST=
- SMTP_PORT=
- SMTP_USER=
- SMTP_PASSWORD=
- STORAGE_URL=
- STORAGE_KEY=

## Step 4: Deploy

Trigger the deployment from GitHub or the hosting dashboard.

## Step 5: Verify health

Check:

- /api/health
- /health
- /health/ready

## Step 6: Create the first super admin

Use the existing registration flow with a secured password and immediately rotate it after creation.

## Step 7: Run the production smoke test

Validate:

- login/logout
- dashboard
- task creation
- task assignment
- employee workflow
- manager review and approval
- notifications
- audit logs
- file uploads

## Step 8: Backup verification

Confirm the PostgreSQL provider supports backups or a documented export/restore process.

## Step 9: Handover

Document the production URL, database provider, host provider, and environment variables in the operations notes.

## Notes

This repository is prepared for deployment, but external credentials and accounts are still required before a live production URL can be created.
