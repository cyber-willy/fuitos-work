const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');

let token = '';

test('health endpoint returns ok', async () => {
  await app.locals.ready;
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('admin login works with seeded data', async () => {
  await app.locals.ready;
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@fuitos.com', password: 'Admin@123' });

  assert.equal(response.status, 200);
  assert.ok(response.body.token);
  token = response.body.token;
});

test('tasks list is accessible to authenticated user', async () => {
  await app.locals.ready;
  const response = await request(app)
    .get('/api/tasks')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body));
  assert.ok(response.body.length > 0);
});

test('manager can create a task', async () => {
  await app.locals.ready;
  const departments = await request(app)
    .get('/api/departments')
    .set('Authorization', `Bearer ${token}`);

  const departmentId = departments.body[0]?.id;
  const response = await request(app)
    .post('/api/tasks')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: 'Test Workflow Task',
      description: 'End-to-end testing task',
      departmentId,
      priority: 'High',
      taskType: 'Development',
      assigneeIds: [],
      dueDate: new Date(Date.now() + 86400000).toISOString()
    });

  assert.equal(response.status, 201);
});

test('employee task submission requires completion note', async () => {
  await app.locals.ready;
  const tasks = await request(app)
    .get('/api/tasks')
    .set('Authorization', `Bearer ${token}`);

  const taskId = tasks.body[0]?.id;
  assert.ok(taskId, 'At least one task should exist for validation.');

  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'liam@fuitos.com', password: 'Employee@123' });

  const employeeToken = login.body.token;
  const response = await request(app)
    .post(`/api/tasks/${taskId}/submit`)
    .set('Authorization', `Bearer ${employeeToken}`)
    .send({});

  assert.equal(response.status, 400);
});
