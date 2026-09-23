const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (NODE_ENV === 'production' ? (() => {
  throw new Error('JWT_SECRET must be set in production.');
})() : 'dev-secret-change-me');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3001').split(',').map((value) => value.trim()).filter(Boolean);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'fuitos.db');
const UPLOAD_PATH = process.env.UPLOAD_PATH || path.join(__dirname, 'uploads');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_PATH, { recursive: true });

let db;

function toPostgresQuery(sql, params) {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

async function dbQueryOne(sql, params = []) {
  const query = toPostgresQuery(sql, params);
  const result = await db.query(query, params);
  return result.rows[0] || null;
}

async function dbQuery(sql, params = []) {
  const query = toPostgresQuery(sql, params);
  const result = await db.query(query, params);
  return result.rows;
}

async function dbRun(sql, params = []) {
  const query = toPostgresQuery(sql, params);
  await db.query(query, params);
}

async function initializeRuntimeDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Set it in the environment before starting the application.');
  }

  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('supabase') || process.env.DATABASE_URL.includes('render') || process.env.DATABASE_URL.includes('neon')
      ? { rejectUnauthorized: true }
      : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  app.locals.db = db;

  try {
    await db.query('SELECT 1');
    await initializeDatabase();
    await seedData();
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    throw error;
  }
}

app.locals.ready = initializeRuntimeDatabase();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_PATH),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'zip'];
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      return cb(new Error('Unsupported file type'));
    }
    cb(null, true);
  }
});

function nowIso() {
  return new Date().toISOString();
}

function zeroPad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${zeroPad(d.getMonth() + 1)}-${zeroPad(d.getDate())}`;
}

async function getUserById(id) {
  return dbQueryOne(`
    SELECT u.*, r.name as role_name, d.name as department_name
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.id = ?
  `, [id]);
}

async function getTaskById(taskId) {
  return dbQueryOne(`
    SELECT t.*, d.name as department_name, u.name AS created_by_name,
           (SELECT COUNT(*) FROM task_assignments ta WHERE ta.task_id = t.id) AS assignee_count
    FROM tasks t
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.id = ?
  `, [taskId]);
}

async function getTaskAssignees(taskId) {
  return dbQuery(`
    SELECT ta.*, u.name, u.email, r.name as role_name
    FROM task_assignments ta
    LEFT JOIN users u ON u.id = ta.user_id
    LEFT JOIN roles r ON r.id = u.role_id
    WHERE ta.task_id = ?
  `, [taskId]);
}

async function createAuditLog(userId, action, resourceType, resourceId, details, ipAddress) {
  await dbRun(`
    INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, details, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [uuidv4(), userId, action, resourceType, resourceId, JSON.stringify(details || {}), ipAddress || null, nowIso()]);
}

async function createNotification(userId, title, message, type, taskId = null) {
  await dbRun(`
    INSERT INTO notifications (id, user_id, title, message, type, related_task_id, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `, [uuidv4(), userId, title, message, type, taskId, nowIso()]);
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(decoded.sub);

    if (!user) {
      return res.status(401).json({ message: 'Invalid session.' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

function requireRole(allowedRoles) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.user.role_name)) {
      return res.status(403).json({ message: 'You do not have permission to perform this action.' });
    }

    next();
  };
}

async function maybeAssignTaskToDepartment(taskId, departmentId, createdBy) {
  if (!departmentId) return;
  const members = await dbQuery(`
    SELECT id FROM users WHERE department_id = ? AND status = 'active'
  `, [departmentId]);

  for (const member of members) {
    await dbRun(`
      INSERT INTO task_assignments (id, task_id, user_id, assigned_by, assigned_at)
      VALUES (?, ?, ?, ?, ?)
    `, [uuidv4(), taskId, member.id, createdBy, nowIso()]);

    await createNotification(member.id, 'New task assigned', 'A new task was assigned to you.', 'task_assigned', taskId);
  }
}

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(80) UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(120) UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(120) NOT NULL UNIQUE,
      description TEXT,
      manager_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_departments_manager FOREIGN KEY (manager_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(160) NOT NULL,
      email VARCHAR(180) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role_id UUID,
      department_id UUID,
      manager_id UUID,
      photo_url TEXT,
      status VARCHAR(40) NOT NULL DEFAULT 'active',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login TIMESTAMPTZ,
      is_verified BOOLEAN NOT NULL DEFAULT TRUE,
      CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id),
      CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments(id),
      CONSTRAINT fk_users_manager FOREIGN KEY (manager_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(160) NOT NULL,
      department_id UUID,
      manager_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_teams_department FOREIGN KEY (department_id) REFERENCES departments(id),
      CONSTRAINT fk_teams_manager FOREIGN KEY (manager_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(220) NOT NULL,
      description TEXT,
      status VARCHAR(40) NOT NULL DEFAULT 'assigned',
      priority VARCHAR(25) NOT NULL DEFAULT 'medium',
      task_type VARCHAR(80) NOT NULL DEFAULT 'administrative',
      tags TEXT,
      department_id UUID,
      created_by UUID,
      start_date TIMESTAMPTZ,
      due_date TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      progress INTEGER NOT NULL DEFAULT 0,
      completion_note TEXT,
      CONSTRAINT fk_tasks_department FOREIGN KEY (department_id) REFERENCES departments(id),
      CONSTRAINT fk_tasks_creator FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS task_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL,
      user_id UUID NOT NULL,
      assigned_by UUID,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_assignments_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      CONSTRAINT fk_assignments_user FOREIGN KEY (user_id) REFERENCES users(id),
      CONSTRAINT fk_assignments_by FOREIGN KEY (assigned_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL,
      user_id UUID NOT NULL,
      parent_comment_id UUID,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_comments_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id),
      CONSTRAINT fk_comments_parent FOREIGN KEY (parent_comment_id) REFERENCES task_comments(id)
    );

    CREATE TABLE IF NOT EXISTS task_attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL,
      user_id UUID NOT NULL,
      file_name VARCHAR(220) NOT NULL,
      file_path TEXT NOT NULL,
      mime_type VARCHAR(120),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_attachments_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      CONSTRAINT fk_attachments_user FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS task_activity (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL,
      user_id UUID NOT NULL,
      action VARCHAR(80) NOT NULL,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_activity_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      title VARCHAR(220) NOT NULL,
      message TEXT NOT NULL,
      type VARCHAR(80) NOT NULL,
      related_task_id UUID,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id),
      CONSTRAINT fk_notifications_task FOREIGN KEY (related_task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      action VARCHAR(120) NOT NULL,
      resource_type VARCHAR(120),
      resource_id TEXT,
      details JSONB,
      ip_address VARCHAR(120),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      token_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      token_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
    CREATE INDEX IF NOT EXISTS idx_users_department ON users(department_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_task_assignments_user ON task_assignments(user_id);
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
  `);

  const roleSeed = [
    ['super_admin', 'Super Admin', 'Complete company access'],
    ['manager', 'Manager', 'Team and task management'],
    ['employee', 'Employee', 'Task completion access']
  ];

  for (const [name, description] of roleSeed.map(([name, label, description]) => [name, description])) {
    const existing = await dbQueryOne('SELECT id FROM roles WHERE name = ?', [name]);
    if (!existing) {
      await dbRun('INSERT INTO roles (id, name, description) VALUES (?, ?, ?)', [uuidv4(), name, description]);
    }
  }

  const permissionSeed = [
    ['users.manage', 'Manage users'],
    ['tasks.manage', 'Manage tasks'],
    ['tasks.assign', 'Assign tasks'],
    ['tasks.review', 'Review task submissions'],
    ['analytics.view', 'View analytics'],
    ['notifications.view', 'View notifications'],
    ['departments.manage', 'Manage departments'],
    ['settings.manage', 'Manage settings']
  ];

  for (const [name, description] of permissionSeed) {
    const existing = await dbQueryOne('SELECT id FROM permissions WHERE name = ?', [name]);
    if (!existing) {
      await dbRun('INSERT INTO permissions (id, name, description) VALUES (?, ?, ?)', [uuidv4(), name, description]);
    }
  }
}

async function seedData() {
  const hasUsers = await dbQueryOne('SELECT 1 FROM users LIMIT 1');
  if (hasUsers) {
    return;
  }

  if (NODE_ENV === 'production') {
    const prodAdminPassword = process.env.PRODUCTION_ADMIN_PASSWORD;
    if (!prodAdminPassword) {
      console.warn('Production mode is active but no PRODUCTION_ADMIN_PASSWORD was provided. No default seed admin was created.');
      return;
    }

    const roleAdmin = await dbQueryOne('SELECT id FROM roles WHERE name = ?', ['super_admin']);
    const departmentId = uuidv4();
    await dbRun(`
      INSERT INTO departments (id, name, description, created_at)
      VALUES (?, ?, ?, ?)
    `, [departmentId, 'Administration', 'Primary internal admin department', nowIso()]);

    await dbRun(`
      INSERT INTO users (id, name, email, password_hash, role_id, department_id, status, joined_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `, [uuidv4(), 'Fuitos Admin', 'admin@fuitos.com', bcrypt.hashSync(prodAdminPassword, 10), roleAdmin.id, departmentId, nowIso()]);
    return;
  }

  const roleAdmin = await dbQueryOne('SELECT id FROM roles WHERE name = ?', ['super_admin']);
  const roleManager = await dbQueryOne('SELECT id FROM roles WHERE name = ?', ['manager']);
  const roleEmployee = await dbQueryOne('SELECT id FROM roles WHERE name = ?', ['employee']);

  const adminId = uuidv4();
  const deptIds = [
    uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4()
  ];

  const departments = [
    ['Engineering', 'Product and system delivery'],
    ['Product', 'Product planning and execution'],
    ['Marketing', 'Growth and campaigns'],
    ['Finance', 'Accounting and financing'],
    ['Operations', 'Operational excellence'],
    ['Customer Support', 'Customer experience'],
    ['Business Development', 'Revenue and partnerships'],
    ['Human Resources', 'People operations']
  ];

  for (const [index, [name, description]] of departments.entries()) {
    await dbRun(`
      INSERT INTO departments (id, name, description, created_at)
      VALUES (?, ?, ?, ?)
    `, [deptIds[index], name, description, nowIso()]);
  }

  const hashedAdmin = bcrypt.hashSync('Admin@123', 10);
  await dbRun(`
    INSERT INTO users (id, name, email, password_hash, role_id, department_id, status, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `, [adminId, 'Ava Thompson', 'admin@fuitos.com', hashedAdmin, roleAdmin.id, deptIds[0], nowIso()]);

  const managerIds = [uuidv4(), uuidv4()];
  const managerNames = ['Noah Davis', 'Sophia Patel'];
  const managerEmails = ['manager1@fuitos.com', 'manager2@fuitos.com'];

  for (const [index, id] of managerIds.entries()) {
    await dbRun(`
      INSERT INTO users (id, name, email, password_hash, role_id, department_id, status, joined_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `, [id, managerNames[index], managerEmails[index], bcrypt.hashSync('Manager@123', 10), roleManager.id, deptIds[index % 4], nowIso()]);
  }

  const employeeNames = [
    'Liam Johnson', 'Olivia Brown', 'Mason White', 'Emma Scott', 'Lucas King', 'Sofia Hall',
    'James Moore', 'Charlotte Lee', 'Benjamin Clark', 'Ella Walker', 'Henry Allen', 'Amelia Young'
  ];

  const employeeEmails = [
    'liam@fuitos.com', 'olivia@fuitos.com', 'mason@fuitos.com', 'emma@fuitos.com', 'lucas@fuitos.com', 'sofia@fuitos.com',
    'james@fuitos.com', 'charlotte@fuitos.com', 'benjamin@fuitos.com', 'ella@fuitos.com', 'henry@fuitos.com', 'amelia@fuitos.com'
  ];

  const employeeIds = [];
  for (const [index, name] of employeeNames.entries()) {
    const id = uuidv4();
    employeeIds.push(id);
    await dbRun(`
      INSERT INTO users (id, name, email, password_hash, role_id, department_id, manager_id, status, joined_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `, [id, name, employeeEmails[index], bcrypt.hashSync('Employee@123', 10), roleEmployee.id, deptIds[index % deptIds.length], managerIds[index % managerIds.length], nowIso()]);
  }

  const sampleTasks = [
    ['Prepare September Marketing Report', 'Review performance and prepare the monthly campaign summary for leadership.', 'assigned', 'high', 'marketing', 'Marketing,Report', deptIds[2], managerIds[0], '2026-09-23T09:00:00.000Z', '2026-09-25T17:00:00.000Z', 20, employeeIds[0]],
    ['Ship Core API Improvements', 'Finalize API performance updates and validate service health.', 'active', 'urgent', 'development', 'Engineering,API', deptIds[0], managerIds[0], '2026-09-22T08:00:00.000Z', '2026-09-24T18:00:00.000Z', 60, employeeIds[1]],
    ['Update Customer Database', 'Clean duplicate records and update customer account details.', 'under_review', 'medium', 'administrative', 'Operations,Finance', deptIds[4], managerIds[1], '2026-09-20T09:00:00.000Z', '2026-09-23T16:00:00.000Z', 100, employeeIds[2]],
    ['Prepare Weekly Email Newsletter', 'Draft the newsletter for the next product launch push.', 'pending', 'high', 'marketing', 'Marketing,Email', deptIds[2], managerIds[0], '2026-09-24T10:00:00.000Z', '2026-09-27T12:00:00.000Z', 10, employeeIds[3]],
    ['Recruiting Pipeline Review', 'Review candidate status and shortlist top prospects.', 'approved', 'medium', 'hr', 'HR,Operations', deptIds[7], managerIds[1], '2026-09-19T08:30:00.000Z', '2026-09-21T12:00:00.000Z', 100, employeeIds[4]],
    ['Finance Forecast Analysis', 'Build a quarterly forecast with revenue and budget scenarios.', 'rejected', 'high', 'finance', 'Finance,Forecast', deptIds[3], managerIds[1], '2026-09-21T08:00:00.000Z', '2026-09-24T17:00:00.000Z', 50, employeeIds[5]],
    ['Customer Support Escalation Review', 'Audit support tickets and prepare recovery recommendations.', 'assigned', 'medium', 'customer support', 'Support,Audit', deptIds[5], managerIds[0], '2026-09-23T07:00:00.000Z', '2026-09-27T15:00:00.000Z', 5, employeeIds[6]],
    ['Business Partner Outreach', 'Prepare call list and outreach plan for strategic partnerships.', 'active', 'high', 'business development', 'Sales,Partnerships', deptIds[6], managerIds[1], '2026-09-22T10:00:00.000Z', '2026-09-28T19:00:00.000Z', 35, employeeIds[7]],
    ['Operations QBR Preparation', 'Create a deck for the quarterly business review meeting.', 'assigned', 'medium', 'operations', 'Operations,Executive', deptIds[4], managerIds[0], '2026-09-23T08:00:00.000Z', '2026-09-26T17:00:00.000Z', 12, employeeIds[8]],
    ['Website Conversion Experiment', 'Design and test changes for conversion improvements.', 'submitted', 'urgent', 'marketing', 'Marketing,Experiment', deptIds[2], managerIds[0], '2026-09-21T11:00:00.000Z', '2026-09-23T18:00:00.000Z', 100, employeeIds[9]],
    ['Mobile App QA Signoff', 'Run regression check and certify the release candidate.', 'active', 'high', 'development', 'Engineering,QA', deptIds[0], managerIds[0], '2026-09-22T09:30:00.000Z', '2026-09-25T18:45:00.000Z', 72, employeeIds[10]],
    ['Employee Onboarding Checklist', 'Finalize onboarding tasks for new hires this month.', 'approved', 'low', 'hr', 'HR,People', deptIds[7], managerIds[1], '2026-09-15T08:00:00.000Z', '2026-09-19T17:00:00.000Z', 100, employeeIds[11]],
    ['Pricing Analysis Review', 'Review current pricing and update growth assumptions.', 'assigned', 'medium', 'finance', 'Finance,Strategy', deptIds[3], managerIds[1], '2026-09-24T08:00:00.000Z', '2026-09-28T15:00:00.000Z', 8, employeeIds[0]],
    ['Customer Retention Campaign', 'Measure retention outcomes and update customer segments.', 'active', 'high', 'marketing', 'Marketing,Retention', deptIds[2], managerIds[0], '2026-09-20T09:00:00.000Z', '2026-09-24T17:00:00.000Z', 65, employeeIds[1]],
    ['Product Launch Checklist', 'Coordinate launch tasks and verify launch readouts.', 'submitted', 'urgent', 'product', 'Product,Launch', deptIds[1], managerIds[1], '2026-09-22T09:00:00.000Z', '2026-09-23T12:00:00.000Z', 100, employeeIds[2]],
    ['Vendor Contract Review', 'Evaluate vendor compliance and budget alignment for renewal.', 'approved', 'medium', 'finance', 'Finance,Contracts', deptIds[3], managerIds[1], '2026-09-17T09:00:00.000Z', '2026-09-20T12:00:00.000Z', 100, employeeIds[3]],
    ['Customer Journey Mapping', 'Document friction points from onboarding through support.', 'active', 'medium', 'product', 'Product,Research', deptIds[1], managerIds[0], '2026-09-23T09:30:00.000Z', '2026-09-28T16:00:00.000Z', 48, employeeIds[4]],
    ['Support Response Template', 'Create response templates for common customer intents.', 'assigned', 'low', 'customer support', 'Support,Templates', deptIds[5], managerIds[0], '2026-09-24T09:00:00.000Z', '2026-09-29T15:00:00.000Z', 6, employeeIds[5]],
    ['Regional Expansion Plan', 'Draft expansion plan for new customer segments.', 'assigned', 'medium', 'business development', 'Growth,Expansion', deptIds[6], managerIds[1], '2026-09-25T10:00:00.000Z', '2026-09-30T17:00:00.000Z', 14, employeeIds[6]],
    ['Payroll Accuracy Check', 'Audit payroll and verify stipend adjustments.', 'active', 'high', 'finance', 'Finance,Payroll', deptIds[3], managerIds[1], '2026-09-22T08:00:00.000Z', '2026-09-25T14:00:00.000Z', 58, employeeIds[7]]
  ];

  for (const [title, description, status, priority, taskType, tags, departmentId, createdBy, startDate, dueDate, progress, assigneeId] of sampleTasks) {
    const taskId = uuidv4();
    await dbRun(`
      INSERT INTO tasks (id, title, description, status, priority, task_type, tags, department_id, created_by, start_date, due_date, created_at, updated_at, progress, completion_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [taskId, title, description, status, priority, taskType, tags, departmentId, createdBy, startDate, dueDate, nowIso(), nowIso(), progress, status === 'rejected' ? 'Needs revision based on manager feedback.' : null]);

    await dbRun(`
      INSERT INTO task_assignments (id, task_id, user_id, assigned_by, assigned_at)
      VALUES (?, ?, ?, ?, ?)
    `, [uuidv4(), taskId, assigneeId, createdBy, nowIso()]);

    await dbRun(`
      INSERT INTO task_activity (id, task_id, user_id, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [uuidv4(), taskId, createdBy, 'task_created', `Task "${title}" created for review.`, nowIso()]);

    await createNotification(assigneeId, 'Task assigned', `You were assigned: ${title}`, 'task_assigned', taskId);
  }

  const firstTaskId = await dbQueryOne('SELECT id FROM tasks ORDER BY created_at LIMIT 1');
  if (firstTaskId) {
    await dbRun(`
      INSERT INTO task_comments (id, task_id, user_id, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [uuidv4(), firstTaskId.id, managerIds[0], 'Please review the final output and send feedback if any changes are needed.', nowIso()]);
  }
}

app.use((req, res, next) => {
  if (!db) {
    return res.status(503).json({ message: 'Database is initializing. Please try again in a moment.' });
  }
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'self'"],
      upgradeInsecureRequests: []
    }
  }
}));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    if (CORS_ORIGIN.includes(origin) || CORS_ORIGIN.includes('*')) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by CORS policy.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
app.use('/uploads', express.static(UPLOAD_PATH));
app.use('/photo', express.static(path.join(__dirname, 'photo')));
app.use(express.static(path.join(__dirname, 'public')));

async function databaseHealthy() {
  try {
    const result = await dbQueryOne('SELECT 1 AS ok');
    return result && result.ok === 1;
  } catch (error) {
    console.error('Database health check failed:', error.message);
    return false;
  }
}

app.get('/api/health', async (_req, res) => {
  if (!db || !(await databaseHealthy())) {
    return res.status(503).json({
      status: 'error',
      message: 'Database unavailable.'
    });
  }

  return res.json({ status: 'ok', message: 'Fuitos Work API is running.', app: APP_URL, environment: NODE_ENV });
});

app.get('/health', async (_req, res) => {
  if (!db || !(await databaseHealthy())) {
    return res.status(503).json({ status: 'unhealthy' });
  }

  return res.status(200).json({ status: 'healthy', environment: NODE_ENV });
});

app.get('/health/ready', async (_req, res) => {
  if (!db || !(await databaseHealthy())) {
    return res.status(503).json({ status: 'not_ready' });
  }

  return res.status(200).json({ status: 'ready', environment: NODE_ENV });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await dbQueryOne(`
    SELECT *
    FROM users
    WHERE email = ?
  `, [normalizedEmail]);

  if (!user || typeof user.password_hash !== 'string' || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '7d' });
  await dbRun('UPDATE users SET last_login = ? WHERE id = ?', [nowIso(), user.id]);

  const safeUser = await getUserById(user.id);
  res.json({
    token,
    user: {
      id: safeUser.id,
      name: safeUser.name,
      email: safeUser.email,
      role: safeUser.role_name,
      department: safeUser.department_name,
      status: safeUser.status,
      joined_at: safeUser.joined_at
    }
  });
});

app.post('/api/auth/register', requireAuth, requireRole(['super_admin']), async (req, res) => {
  const { name, email, password, role, departmentId } = req.body;

  if (!name || !email || !password || !role || !departmentId) {
    return res.status(400).json({ message: 'Name, email, password, role and department are required.' });
  }

  const roleRecord = await dbQueryOne('SELECT * FROM roles WHERE name = ?', [role]);
  if (!roleRecord) {
    return res.status(400).json({ message: 'Invalid role selected.' });
  }

  const exists = await dbQueryOne('SELECT 1 FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
  if (exists) {
    return res.status(409).json({ message: 'User already exists.' });
  }

  const id = uuidv4();
  await dbRun(`
    INSERT INTO users (id, name, email, password_hash, role_id, department_id, status, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `, [id, name, String(email).trim().toLowerCase(), bcrypt.hashSync(password, 10), roleRecord.id, departmentId, nowIso()]);

  await createAuditLog(req.user.id, 'user_created', 'users', id, { name, email, role }, req.ip);
  res.status(201).json({ message: 'User created successfully.' });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: { ...req.user, role: req.user.role_name, department: req.user.department_name } });
});

app.get('/api/users', requireAuth, async (req, res) => {
  const rows = await dbQuery(`
    SELECT u.*, r.name as role_name, d.name as department_name
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id
    ORDER BY u.name ASC
  `);
  res.json(rows);
});

app.get('/api/departments', requireAuth, async (req, res) => {
  const rows = await dbQuery(`
    SELECT d.*, u.name as manager_name
    FROM departments d
    LEFT JOIN users u ON u.id = d.manager_id
    ORDER BY d.name ASC
  `);
  res.json(rows);
});

app.post('/api/departments', requireAuth, requireRole(['super_admin', 'manager']), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ message: 'Department name is required.' });

  const id = uuidv4();
  await dbRun('INSERT INTO departments (id, name, description) VALUES (?, ?, ?)', [id, name, description || '']);
  await createAuditLog(req.user.id, 'department_created', 'departments', id, { name }, req.ip);
  res.status(201).json({ id, name, description: description || '' });
});

app.get('/api/tasks', requireAuth, async (req, res) => {
  const { status, department, q, assignee } = req.query;
  const user = req.user;
  let query = `
    SELECT t.*, d.name as department_name, u.name as created_by_name,
    GROUP_CONCAT(ta.user_id) AS assignee_ids,
    GROUP_CONCAT(ta2.user_name) AS assignee_names
    FROM tasks t
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN task_assignments ta ON ta.task_id = t.id
    LEFT JOIN (
      SELECT ta.task_id, u.name as user_name FROM task_assignments ta
      LEFT JOIN users u ON u.id = ta.user_id
    ) ta2 ON ta2.task_id = t.id
    WHERE 1 = 1
  `;

  const params = [];
  if (status && status !== 'all') { query += ' AND t.status = ?'; params.push(status); }
  if (department && department !== 'all') { query += ' AND t.department_id = ?'; params.push(department); }
  if (q) { query += ' AND (t.title LIKE ? OR t.description LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }

  if (user.role_name === 'employee') {
    query += ' AND EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id AND ta.user_id = ?)';
    params.push(user.id);
  }

  query += ' GROUP BY t.id ORDER BY t.updated_at DESC';

  const rows = await dbQuery(query, params);
  res.json(rows.map(task => ({
    ...task,
    assignee_ids: task.assignee_ids ? task.assignee_ids.split(',') : [],
    assignee_names: task.assignee_names ? task.assignee_names.split(',') : []
  })));
});

app.get('/api/tasks/:id', requireAuth, async (req, res) => {
  const task = await getTaskById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found.' });

  const assignees = await getTaskAssignees(task.id);
  const comments = await dbQuery(`
    SELECT c.*, u.name as user_name
    FROM task_comments c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ?
    ORDER BY c.created_at ASC
  `, [task.id]);

  const attachments = await dbQuery(`
    SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at DESC
  `, [task.id]);

  const activity = await dbQuery(`
    SELECT a.*, u.name as user_name
    FROM task_activity a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.task_id = ?
    ORDER BY a.created_at DESC
  `, [task.id]);

  res.json({ task, assignees, comments, attachments, activity });
});

app.post('/api/tasks', requireAuth, requireRole(['super_admin', 'manager']), async (req, res) => {
  const { title, description, departmentId, assigneeIds = [], priority = 'medium', taskType = 'administrative', tags = '', dueDate, startDate, status = 'assigned', progress = 0 } = req.body;

  if (!title || !departmentId) {
    return res.status(400).json({ message: 'Task title and department are required.' });
  }

  const taskId = uuidv4();
  await dbRun(`
    INSERT INTO tasks (id, title, description, status, priority, task_type, tags, department_id, created_by, start_date, due_date, created_at, updated_at, progress)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [taskId, title, description || '', status, priority, taskType, tags.join ? tags.join(',') : String(tags || ''), departmentId, req.user.id, startDate || null, dueDate || null, nowIso(), nowIso(), Number(progress) || 0]);

  const identifiers = Array.isArray(assigneeIds) && assigneeIds.length ? assigneeIds : [];
  if (!identifiers.length) {
    await maybeAssignTaskToDepartment(taskId, departmentId, req.user.id);
  } else {
    for (const assigneeId of identifiers) {
      await dbRun(`
        INSERT INTO task_assignments (id, task_id, user_id, assigned_by, assigned_at)
        VALUES (?, ?, ?, ?, ?)
      `, [uuidv4(), taskId, assigneeId, req.user.id, nowIso()]);

      await createNotification(assigneeId, 'New task assigned', `You were assigned: ${title}`, 'task_assigned', taskId);
    }
  }

  await dbRun(`
    INSERT INTO task_activity (id, task_id, user_id, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [uuidv4(), taskId, req.user.id, 'task_created', `Task "${title}" was created.`, nowIso()]);

  await createAuditLog(req.user.id, 'task_created', 'tasks', taskId, { title, departmentId, assigneeIds: identifiers }, req.ip);
  res.status(201).json({ message: 'Task created successfully.', taskId });
});

app.patch('/api/tasks/:id', requireAuth, async (req, res) => {
  const task = await getTaskById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found.' });

  const allowedRoles = ['super_admin', 'manager'];
  if (req.user.role_name === 'employee' && req.user.id !== task.created_by) {
    return res.status(403).json({ message: 'You cannot edit this task.' });
  }

  const updates = { ...req.body };
  const validKeys = ['title', 'description', 'status', 'priority', 'task_type', 'tags', 'department_id', 'start_date', 'due_date', 'progress', 'completion_note'];
  const setClauses = [];
  const values = [];

  Object.entries(updates).forEach(([key, value]) => {
    if (validKeys.includes(key)) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  });

  if (!setClauses.length) {
    return res.status(400).json({ message: 'No valid task fields were provided.' });
  }

  values.push(req.params.id);
  await dbRun(`UPDATE tasks SET ${setClauses.join(', ')}, updated_at = ? WHERE id = ?`, [...values, nowIso()]);
  await createAuditLog(req.user.id, 'task_updated', 'tasks', req.params.id, updates, req.ip);
  res.json({ message: 'Task updated successfully.' });
});

app.post('/api/tasks/:id/start', requireAuth, async (req, res) => {
  const task = await getTaskById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found.' });

  const userIsAssigned = await dbQueryOne('SELECT 1 FROM task_assignments WHERE task_id = ? AND user_id = ?', [task.id, req.user.id]);
  if (!userIsAssigned && req.user.role_name !== 'manager' && req.user.role_name !== 'super_admin') {
    return res.status(403).json({ message: 'You are not assigned to this task.' });
  }

  await dbRun('UPDATE tasks SET status = ?, start_date = COALESCE(start_date, ?), progress = 25, updated_at = ? WHERE id = ?', ['active', nowIso(), nowIso(), task.id]);
  await dbRun(`INSERT INTO task_activity (id, task_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [uuidv4(), task.id, req.user.id, 'task_started', 'Task started by the assignee.', nowIso()]);
  await createNotification(req.user.id, 'Task started', `You started: ${task.title}`, 'task_started', task.id);
  res.json({ message: 'Task started.' });
});

app.post('/api/tasks/:id/submit', requireAuth, async (req, res) => {
  const task = await getTaskById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found.' });

  const { completionNote } = req.body;
  if (!completionNote) return res.status(400).json({ message: 'A completion note is required before submission.' });

  await dbRun('UPDATE tasks SET status = ?, progress = 100, completion_note = ?, updated_at = ? WHERE id = ?', ['under_review', completionNote, nowIso(), task.id]);
  await dbRun(`INSERT INTO task_activity (id, task_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [uuidv4(), task.id, req.user.id, 'task_submitted', 'Task submitted for review.', nowIso()]);

  const assignees = await getTaskAssignees(task.id);
  for (const assignee of assignees) {
    if (assignee.user_id !== req.user.id) {
      await createNotification(assignee.user_id, 'Task submission', `${req.user.name} submitted a task for review: ${task.title}`, 'task_review', task.id);
    }
  }

  const managers = await dbQuery('SELECT id FROM users WHERE role_id = (SELECT id FROM roles WHERE name = ?) OR role_id = (SELECT id FROM roles WHERE name = ?)', ['manager', 'super_admin']);
  for (const manager of managers) {
    await createNotification(manager.id, 'Task awaiting review', `${task.title} is ready for manager approval.`, 'task_submitted', task.id);
  }

  res.json({ message: 'Task submitted for review.' });
});

app.post('/api/tasks/:id/approve', requireAuth, requireRole(['super_admin', 'manager']), async (req, res) => {
  const task = await getTaskById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found.' });

  await dbRun('UPDATE tasks SET status = ?, progress = 100, updated_at = ? WHERE id = ?', ['approved', nowIso(), task.id]);
  await dbRun(`INSERT INTO task_activity (id, task_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [uuidv4(), task.id, req.user.id, 'task_approved', 'Task approved by manager.', nowIso()]);

  const assignees = await getTaskAssignees(task.id);
  for (const assignee of assignees) {
    await createNotification(assignee.user_id, 'Task approved', `Your task was approved: ${task.title}`, 'task_approved', task.id);
  }
  res.json({ message: 'Task approved.' });
});

app.post('/api/tasks/:id/reject', requireAuth, requireRole(['super_admin', 'manager']), async (req, res) => {
  const task = await getTaskById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found.' });

  const { feedback } = req.body;
  if (!feedback) return res.status(400).json({ message: 'Manager feedback is required when rejecting a task.' });

  await dbRun('UPDATE tasks SET status = ?, progress = 40, completion_note = ?, updated_at = ? WHERE id = ?', ['rejected', feedback, nowIso(), task.id]);
  await dbRun(`INSERT INTO task_activity (id, task_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [uuidv4(), task.id, req.user.id, 'task_rejected', `Task rejected with feedback: ${feedback}`, nowIso()]);

  const assignees = await getTaskAssignees(task.id);
  for (const assignee of assignees) {
    await createNotification(assignee.user_id, 'Task rejected', `Your task was rejected and requires revision: ${task.title} - ${feedback}`, 'task_rejected', task.id);
  }
  res.json({ message: 'Task rejected and feedback sent to the assignee.' });
});

app.post('/api/tasks/:id/comments', requireAuth, async (req, res) => {
  const task = await getTaskById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found.' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ message: 'Comment text is required.' });

  const commentId = uuidv4();
  await dbRun(`
    INSERT INTO task_comments (id, task_id, user_id, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `, [commentId, task.id, req.user.id, message, nowIso()]);

  await dbRun(`INSERT INTO task_activity (id, task_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [uuidv4(), task.id, req.user.id, 'comment_added', `Comment added: ${message}`, nowIso()]);

  res.status(201).json({ message: 'Comment added successfully.' });
});

app.post('/api/tasks/:id/upload', requireAuth, upload.single('file'), async (req, res) => {
  const task = await getTaskById(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

  await dbRun(`
    INSERT INTO task_attachments (id, task_id, user_id, file_name, file_path, mime_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [uuidv4(), task.id, req.user.id, req.file.originalname, `/uploads/${req.file.filename}`, req.file.mimetype, nowIso()]);

  await dbRun(`INSERT INTO task_activity (id, task_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [uuidv4(), task.id, req.user.id, 'file_uploaded', `File uploaded: ${req.file.originalname}`, nowIso()]);

  res.status(201).json({ message: 'File uploaded successfully.' });
});

app.get('/api/notifications', requireAuth, async (req, res) => {
  const rows = await dbQuery(`
    SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `, [req.user.id]);
  res.json(rows);
});

app.patch('/api/notifications/:id/read', requireAuth, async (req, res) => {
  await dbRun('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ message: 'Notification marked as read.' });
});

app.get('/api/dashboard/overview', requireAuth, async (req, res) => {
  const totalEmployees = (await dbQueryOne('SELECT COUNT(*) as count FROM users WHERE role_id != (SELECT id FROM roles WHERE name = ?)', ['super_admin'])).count;
  const activeEmployees = (await dbQueryOne('SELECT COUNT(*) as count FROM users WHERE status = ? AND role_id != (SELECT id FROM roles WHERE name = ?)', ['active', 'super_admin'])).count;
  const totalTasks = (await dbQueryOne('SELECT COUNT(*) as count FROM tasks')).count;
  const pendingTasks = (await dbQueryOne('SELECT COUNT(*) as count FROM tasks WHERE status = ?', ['assigned'])).count;
  const activeTasks = (await dbQueryOne('SELECT COUNT(*) as count FROM tasks WHERE status = ?', ['active'])).count;
  const completedTasks = (await dbQueryOne('SELECT COUNT(*) as count FROM tasks WHERE status = ?', ['approved'])).count;
  const overdueTasks = (await dbQueryOne("SELECT COUNT(*) as count FROM tasks WHERE due_date IS NOT NULL AND due_date < ? AND status NOT IN ('approved', 'cancelled')", [nowIso()])).count;
  const awaitingReview = (await dbQueryOne('SELECT COUNT(*) as count FROM tasks WHERE status = ?', ['under_review'])).count;

  const taskSeries = await dbQuery(`
    SELECT DATE_TRUNC('month', created_at)::text as month, COUNT(*) as total
    FROM tasks GROUP BY DATE_TRUNC('month', created_at)
    ORDER BY month ASC
  `);

  const recentActivity = await dbQuery(`
    SELECT a.*, u.name as user_name, t.title as task_title
    FROM task_activity a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN tasks t ON t.id = a.task_id
    ORDER BY a.created_at DESC LIMIT 10
  `);

  const workload = await dbQuery(`
    SELECT u.name, COUNT(ta.task_id) as active_tasks
    FROM users u
    LEFT JOIN task_assignments ta ON ta.user_id = u.id
    LEFT JOIN tasks t ON t.id = ta.task_id AND t.status IN ('assigned', 'active', 'under_review')
    WHERE u.role_id = (SELECT id FROM roles WHERE name = 'employee')
    GROUP BY u.id
    ORDER BY active_tasks DESC
    LIMIT 8
  `);

  const stats = {
    totalEmployees,
    activeEmployees,
    totalTasks,
    pendingTasks,
    activeTasks,
    completedTasks,
    overdueTasks,
    awaitingReview
  };

  res.json({ stats, taskSeries, recentActivity, workload });
});

app.get('/api/analytics', requireAuth, async (req, res) => {
  const employeeMetrics = await dbQuery(`
    SELECT u.name, u.email, d.name as department_name,
           COUNT(DISTINCT ta.task_id) as tasks_assigned,
           COUNT(DISTINCT CASE WHEN t.status = 'active' THEN ta.task_id END) as tasks_active,
           COUNT(DISTINCT CASE WHEN t.status = 'approved' THEN ta.task_id END) as tasks_completed,
           COUNT(DISTINCT CASE WHEN t.status = 'under_review' THEN ta.task_id END) as tasks_review,
           COUNT(DISTINCT CASE WHEN t.status = 'rejected' THEN ta.task_id END) as tasks_rejected,
           COUNT(DISTINCT CASE WHEN t.due_date < ? AND t.status NOT IN ('approved', 'cancelled') THEN ta.task_id END) as tasks_overdue
    FROM users u
    LEFT JOIN task_assignments ta ON ta.user_id = u.id
    LEFT JOIN tasks t ON t.id = ta.task_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.role_id = (SELECT id FROM roles WHERE name = 'employee')
    GROUP BY u.id
  `, [nowIso()]);

  res.json({ employeeMetrics });
});

app.get('/api/audit-logs', requireAuth, requireRole(['super_admin', 'manager']), async (req, res) => {
  const logs = await dbQuery(`
    SELECT a.*, u.name as user_name
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC LIMIT 50
  `);
  res.json(logs);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled server error:', error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({ message: error.message });
  }

  if (error) {
    return res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

if (require.main === module) {
  app.locals.ready.then(() => {
    const server = app.listen(PORT, () => {
      console.log(`Fuitos Work API running on http://localhost:${PORT}`);
    });

    const gracefulShutdown = (signal) => {
      console.log(`Received ${signal}. Shutting down gracefully.`);
      server.close(() => {
        if (db) {
          db.close();
        }
        process.exit(0);
      });
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  });
}

module.exports = app;
