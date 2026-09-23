const state = {
  token: localStorage.getItem('fuitosToken') || '',
  user: JSON.parse(localStorage.getItem('fuitosUser') || 'null'),
  section: 'dashboard',
  overview: null,
  tasks: [],
  users: [],
  departments: [],
  notifications: [],
  analytics: [],
  auditLogs: []
};

const app = document.getElementById('app');
const toastContainer = document.getElementById('toast-container');

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

async function apiFetch(url, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const resp = await fetch(url, { ...options, headers });
  const text = await resp.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (error) { payload = null; }

  if (!resp.ok) {
    const message = payload?.message || 'Request failed.';
    throw new Error(message);
  }

  return payload;
}

function logout() {
  state.token = '';
  state.user = null;
  localStorage.removeItem('fuitosToken');
  localStorage.removeItem('fuitosUser');
  render();
}

async function login(email, password) {
  const payload = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  state.token = payload.token;
  state.user = payload.user;
  localStorage.setItem('fuitosToken', payload.token);
  localStorage.setItem('fuitosUser', JSON.stringify(payload.user));
  await loadData();
  render();
}

async function loadData() {
  if (!state.token) return;

  try {
    const [overview, tasks, users, departments, notifications] = await Promise.all([
      apiFetch('/api/dashboard/overview'),
      apiFetch('/api/tasks'),
      apiFetch('/api/users'),
      apiFetch('/api/departments'),
      apiFetch('/api/notifications')
    ]);

    state.overview = overview;
    state.tasks = tasks;
    state.users = users;
    state.departments = departments;
    state.notifications = notifications;

    if (state.user?.role === 'manager' || state.user?.role === 'super_admin') {
      state.analytics = await apiFetch('/api/analytics');
      state.auditLogs = await apiFetch('/api/audit-logs');
    }
  } catch (error) {
    console.error(error.message);
    showToast(error.message);
  }
}

function statusClass(status) {
  return `status-${String(status).replace(/\s+/g, '_').toLowerCase()}`;
}

function priorityClass(priority) {
  return `priority-${String(priority).toLowerCase()}`;
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-brand">
          <img class="login-logo" src="/photo/myphoto.jpeg" alt="Fuitos logo" />
          <div style="font-weight:800; font-size:1.4rem; margin-left:8px;">Fuitos Work</div>
        </div>
        <h2>Employee Task & Performance Platform</h2>
        <div class="login-subtitle">Sign in to manage tasks, activity, and team productivity.</div>
        <form id="loginForm">
          <div class="form-grid">
            <label>
              Email
              <input type="email" id="email" value="admin@fuitos.com" required />
            </label>
            <label>
              Password
              <input type="password" id="password" value="Admin@123" required />
            </label>
          </div>
          <div class="form-actions">
            <div class="chip">Demo account ready</div>
            <button class="primary-btn" type="submit">Login</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    try {
      await login(email, password);
    } catch (error) {
      showToast(error.message);
    }
  });
}

function renderMainLayout() {
  const nav = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'myTasks', label: 'My Tasks' },
    { id: 'allTasks', label: 'All Tasks' },
    { id: 'employees', label: 'Employees' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'notifications', label: 'Notifications' }
  ];

  const visibleNav = state.user.role === 'super_admin' || state.user.role === 'manager' ? nav.concat([{ id: 'audit', label: 'Audit Logs' }]) : nav;

  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <img class="brand-logo" src="/photo/myphoto.jpeg" alt="Fuitos logo" />
          <div>Fuitos</div>
        </div>
        <nav class="nav-list">
          ${visibleNav.map(item => `
            <button class="nav-button ${state.section === item.id ? 'active' : ''}" data-section="${item.id}">${item.label}</button>
          `).join('')}
        </nav>
        <div class="user-card">
          <div style="font-size:0.76rem; color:#cfe0ff; text-transform:uppercase; letter-spacing:0.08em;">Signed in</div>
          <div style="font-weight:700; margin-top:8px;">${state.user.name}</div>
          <div style="color:#cfe0ff; font-size:0.84rem; margin-top:6px;">${state.user.role}</div>
          <button class="secondary-btn" style="margin-top:14px; width:100%;" id="logoutButton">Logout</button>
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <div>
            <div class="chip">Good ${new Date().getHours() < 12 ? 'morning' : 'afternoon'}, ${state.user.name}</div>
            <h1>Here's what's happening with your team today.</h1>
          </div>
          <div class="toolbar">
            <button class="secondary-btn" id="createTaskBtn">+ Create Task</button>
            <div class="notification-bell">
              <span>🔔</span>
              ${state.notifications.filter(n => !n.is_read).length ? `<span class="badge">${state.notifications.filter(n => !n.is_read).length}</span>` : ''}
            </div>
          </div>
        </div>
        <div id="page-content"></div>
      </main>
    </div>
  `;

  document.getElementById('logoutButton').addEventListener('click', logout);
  document.getElementById('createTaskBtn').addEventListener('click', openTaskModal);

  document.querySelectorAll('.nav-button').forEach(button => {
    button.addEventListener('click', () => {
      state.section = button.dataset.section;
      render();
    });
  });

  const content = document.getElementById('page-content');
  if (state.section === 'dashboard') {
    content.innerHTML = renderDashboard();
  } else if (state.section === 'myTasks') {
    content.innerHTML = renderTaskList('my');
  } else if (state.section === 'allTasks') {
    content.innerHTML = renderTaskList('all');
  } else if (state.section === 'employees') {
    content.innerHTML = renderEmployees();
  } else if (state.section === 'analytics') {
    content.innerHTML = renderAnalytics();
  } else if (state.section === 'notifications') {
    content.innerHTML = renderNotifications();
  } else if (state.section === 'audit') {
    content.innerHTML = renderAuditLogs();
  }

  bindTaskButtons();
}

function renderDashboard() {
  const stats = state.overview?.stats || {};
  const cards = [
    ['Total Employees', stats.totalEmployees || 0],
    ['Active Employees', stats.activeEmployees || 0],
    ['Total Tasks', stats.totalTasks || 0],
    ['Pending Tasks', stats.pendingTasks || 0],
    ['Active Tasks', stats.activeTasks || 0],
    ['Completed Tasks', stats.completedTasks || 0],
    ['Overdue Tasks', stats.overdueTasks || 0],
    ['Awaiting Review', stats.awaitingReview || 0]
  ];

  const recent = state.overview?.recentActivity || [];
  const workload = state.overview?.workload || [];

  return `
    <div class="card-grid">
      ${cards.map(([label, value]) => `
        <div class="stat-card">
          <div class="stat-label">${label}</div>
          <div class="stat-value">${value}</div>
          <div class="small-note">Updated from live task data</div>
        </div>
      `).join('')}
    </div>
    <div class="section">
      <div class="section-header">
        <h3>Recent Activity</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Action</th>
              <th>Task</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            ${recent.slice(0, 8).map(item => `
              <tr>
                <td>${item.user_name}</td>
                <td>${item.action}</td>
                <td>${item.task_title || 'System event'}</td>
                <td>${new Date(item.created_at).toLocaleString()}</td>
              </tr>
            `).join('') || '<tr><td colspan="4">No recent activity yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    <div class="section">
      <div class="section-header">
        <h3>Team Workload</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Active Tasks</th>
            </tr>
          </thead>
          <tbody>
            ${workload.map(item => `
              <tr>
                <td>${item.name}</td>
                <td>${item.active_tasks}</td>
              </tr>
            `).join('') || '<tr><td colspan="2">No workload data.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderTaskList(type) {
  const tasks = type === 'my' ? state.tasks.filter(task => task.assignee_ids.includes(state.user.id) || task.created_by === state.user.id) : state.tasks;
  return `
    <div class="section">
      <div class="section-header">
        <h3>${type === 'my' ? 'My Tasks' : 'All Tasks'}</h3>
        <div class="row">
          <select id="taskFilterStatus">
            <option value="all">All statuses</option>
            <option value="assigned">Assigned</option>
            <option value="active">Active</option>
            <option value="under_review">Under Review</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Due</th>
              <th>Progress</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${tasks.map(task => `
              <tr>
                <td>
                  <strong>${task.title}</strong><br>
                  <span class="small-note">${task.department_name}</span>
                </td>
                <td><span class="priority-badge ${priorityClass(task.priority)}">${task.priority}</span></td>
                <td><span class="status-badge ${statusClass(task.status)}">${task.status}</span></td>
                <td>${task.due_date ? new Date(task.due_date).toLocaleDateString() : 'N/A'}</td>
                <td>${task.progress || 0}%</td>
                <td>
                  <div class="row">
                    <button class="secondary-btn" data-action="openTask" data-id="${task.id}">View</button>
                    ${task.status === 'assigned' ? `<button class="primary-btn" data-action="startTask" data-id="${task.id}">Start</button>` : ''}
                    ${task.status === 'active' ? `<button class="primary-btn" data-action="submitTask" data-id="${task.id}">Submit</button>` : ''}
                    ${(state.user.role === 'manager' || state.user.role === 'super_admin') && task.status === 'under_review' ? `<button class="primary-btn" data-action="approveTask" data-id="${task.id}">Approve</button>` : ''}
                  </div>
                </td>
              </tr>
            `).join('') || '<tr><td colspan="6">No tasks found.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('taskFilterStatus')?.addEventListener('change', (event) => {
    const value = event.target.value;
    const filtered = value === 'all' ? state.tasks : state.tasks.filter(task => task.status === value);
    state.tasks = filtered;
    render();
  });
}

function renderEmployees() {
  return `
    <div class="section">
      <div class="section-header">
        <h3>Employees</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Department</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${state.users.map(user => `
              <tr>
                <td>${user.name}</td>
                <td>${user.email}</td>
                <td>${user.role_name}</td>
                <td>${user.department_name || 'Unassigned'}</td>
                <td><span class="status-badge ${user.status === 'active' ? 'status-active' : 'status-rejected'}">${user.status}</span></td>
              </tr>
            `).join('') || '<tr><td colspan="5">No employees found.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAnalytics() {
  const metrics = state.analytics?.employeeMetrics || [];
  return `
    <div class="section">
      <div class="section-header">
        <h3>Performance Analytics</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Assigned</th>
              <th>Active</th>
              <th>Completed</th>
              <th>Review</th>
              <th>Overdue</th>
            </tr>
          </thead>
          <tbody>
            ${metrics.map(item => `
              <tr>
                <td>${item.name}</td>
                <td>${item.tasks_assigned || 0}</td>
                <td>${item.tasks_active || 0}</td>
                <td>${item.tasks_completed || 0}</td>
                <td>${item.tasks_review || 0}</td>
                <td>${item.tasks_overdue || 0}</td>
              </tr>
            `).join('') || '<tr><td colspan="6">No analytics available.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderNotifications() {
  return `
    <div class="section">
      <div class="section-header">
        <h3>Notifications</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Message</th>
              <th>Type</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            ${state.notifications.map(notification => `
              <tr>
                <td>${notification.title}</td>
                <td>${notification.message}</td>
                <td>${notification.type}</td>
                <td>${new Date(notification.created_at).toLocaleString()}</td>
              </tr>
            `).join('') || '<tr><td colspan="4">No notifications.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAuditLogs() {
  return `
    <div class="section">
      <div class="section-header">
        <h3>Audit Logs</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Action</th>
              <th>Details</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            ${(state.auditLogs || []).map(log => `
              <tr>
                <td>${log.user_name || 'System'}</td>
                <td>${log.action}</td>
                <td>${JSON.stringify(log.details || {})}</td>
                <td>${new Date(log.created_at).toLocaleString()}</td>
              </tr>
            `).join('') || '<tr><td colspan="4">No audit logs yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function bindTaskButtons() {
  document.querySelectorAll('[data-action]').forEach(button => {
    const action = button.dataset.action;
    const taskId = button.dataset.id;
    button.addEventListener('click', async () => {
      try {
        if (action === 'openTask') {
          await openTask(taskId);
          return;
        }
        if (action === 'startTask') {
          await apiFetch(`/api/tasks/${taskId}/start`, { method: 'POST' });
          await loadData();
          render();
          showToast('Task started successfully.');
          return;
        }
        if (action === 'submitTask') {
          const note = prompt('Add your completion note before submitting:');
          if (!note) return;
          await apiFetch(`/api/tasks/${taskId}/submit`, {
            method: 'POST',
            body: JSON.stringify({ completionNote: note })
          });
          await loadData();
          render();
          showToast('Task submitted for review.');
          return;
        }
        if (action === 'approveTask') {
          await apiFetch(`/api/tasks/${taskId}/approve`, { method: 'POST' });
          await loadData();
          render();
          showToast('Task approved.');
        }
      } catch (error) {
        showToast(error.message);
      }
    });
  });
}

async function openTask(taskId) {
  const taskData = await apiFetch(`/api/tasks/${taskId}`);
  const task = taskData.task;
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal">
      <div class="section-header">
        <h3>${task.title}</h3>
        <button class="secondary-btn" data-close>Close</button>
      </div>
      <div class="form-grid">
        <div><strong>Priority:</strong> ${task.priority}</div>
        <div><strong>Status:</strong> ${task.status}</div>
        <div><strong>Progress:</strong> ${task.progress}%</div>
        <div><strong>Due:</strong> ${task.due_date ? new Date(task.due_date).toLocaleString() : 'N/A'}</div>
      </div>
      <p>${task.description || 'No description available.'}</p>
      <h4>Comments</h4>
      <div>
        ${taskData.comments.length ? taskData.comments.map(comment => `
          <div style="padding:10px; border:1px solid var(--line); border-radius:10px; margin-bottom:8px;">
            <strong>${comment.user_name}</strong><br>
            <small>${new Date(comment.created_at).toLocaleString()}</small><br>
            ${comment.message}
          </div>
        `).join('') : '<div>No comments yet.</div>'}
      </div>
      <div style="margin-top:16px;">
        <textarea id="commentInput" placeholder="Add a comment"></textarea>
        <div class="form-actions">
          <button class="primary-btn" id="submitCommentBtn">Add Comment</button>
          ${state.user.role === 'manager' || state.user.role === 'super_admin' ? `<button class="danger-btn" id="rejectTaskBtn">Reject</button>` : ''}
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.querySelector('[data-close]').addEventListener('click', () => modal.remove());

  document.getElementById('submitCommentBtn').addEventListener('click', async () => {
    const message = document.getElementById('commentInput').value;
    if (!message) return showToast('Comment cannot be empty.');
    await apiFetch(`/api/tasks/${taskId}/comments`, { method: 'POST', body: JSON.stringify({ message }) });
    await loadData();
    modal.remove();
    render();
    showToast('Comment added.');
  });

  document.getElementById('rejectTaskBtn')?.addEventListener('click', async () => {
    const feedback = prompt('Enter rejection feedback:');
    if (!feedback) return;
    await apiFetch(`/api/tasks/${taskId}/reject`, { method: 'POST', body: JSON.stringify({ feedback }) });
    await loadData();
    modal.remove();
    render();
    showToast('Task rejected with feedback.');
  });
}

function openTaskModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal">
      <div class="section-header">
        <h3>Create Task</h3>
        <button class="secondary-btn" data-close>Close</button>
      </div>
      <form id="taskForm">
        <div class="form-grid">
          <label>Task Title<input name="title" required /></label>
          <label>Department<select name="departmentId">
            ${state.departments.map(dept => `<option value="${dept.id}">${dept.name}</option>`).join('')}
          </select></label>
          <label>Priority<select name="priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Urgent</option></select></label>
          <label>Type<select name="taskType"><option>Development</option><option>Marketing</option><option>Research</option><option>Meeting</option><option>Customer Support</option><option>Administrative</option><option>Other</option></select></label>
          <label>Start Date<input type="datetime-local" name="startDate" /></label>
          <label>Due Date<input type="datetime-local" name="dueDate" required /></label>
          <label style="grid-column: 1 / -1;">Description<textarea name="description" required></textarea></label>
          <label style="grid-column: 1 / -1;">Assign to<select name="assigneeIds" multiple size="6">
            ${state.users.filter(user => user.role_name === 'employee').map(user => `<option value="${user.id}">${user.name}</option>`).join('')}
          </select></label>
        </div>
        <div class="form-actions" style="justify-content:flex-end; margin-top:18px;">
          <button class="secondary-btn" type="button" data-close>Cancel</button>
          <button class="primary-btn" type="submit">Create Task</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);
  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => modal.remove()));

  document.getElementById('taskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const assigneeIds = [...form.assigneeIds.selectedOptions].map(option => option.value);
    const payload = {
      title: form.title.value,
      description: form.description.value,
      departmentId: form.departmentId.value,
      priority: form.priority.value,
      taskType: form.taskType.value,
      startDate: form.startDate.value ? new Date(form.startDate.value).toISOString() : null,
      dueDate: form.dueDate.value ? new Date(form.dueDate.value).toISOString() : null,
      assigneeIds
    };

    await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
    await loadData();
    modal.remove();
    render();
    showToast('Task created successfully.');
  });
}

async function render() {
  if (!state.token || !state.user) {
    renderLogin();
    return;
  }
  renderMainLayout();
}

(async function init() {
  if (state.token && state.user) {
    await loadData();
  }
  render();
})();
