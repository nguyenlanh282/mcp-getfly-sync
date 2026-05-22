// ── State ──
let currentPage = 'dashboard';
let ordersPage = 1;
let searchTimer = null;
let logAutoTimer = null;

// ── Navigation ──
document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => navigateTo(item.dataset.page));
});

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');

  if (page === 'dashboard') loadDashboard();
  if (page === 'orders') refreshOrders();
  if (page === 'staff') refreshStaff();
  if (page === 'settings') loadConfig();
  if (page === 'logs') { refreshLogs(); startLogAutoRefresh(); }
  if (page !== 'logs') stopLogAutoRefresh();
}

// ── API Helper ──
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = '/auth/login';
    return null;
  }
  return res.json();
}

// ── Logout ──
async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/auth/login';
}

// ── Toast ──
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Save Result feedback ──
function showSaveResult(sectionId, success, message) {
  const el = document.getElementById(`save-result-${sectionId}`);
  if (!el) return;
  el.className = `save-result ${success ? 'success' : 'error'}`;
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ── Format helpers ──
function formatTime(isoString) {
  if (!isoString) return 'N/A';
  return new Date(isoString).toLocaleString('vi-VN', { hour12: false });
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatBytes(bytes) {
  return Math.round(bytes / 1024 / 1024) + ' MB';
}

function statusBadge(status) {
  const map = {
    synced: ['badge-synced', 'Synced'],
    updated: ['badge-updated', 'Updated'],
    error: ['badge-error', 'Error'],
    'unmapped-staff': ['badge-unmapped', 'Unmapped'],
    'not-on-getfly': ['badge-pending', 'Not on Getfly'],
    'no-chat-assignee': ['badge-pending', 'No Assignee'],
    unknown: ['badge-pending', 'Unknown'],
  };
  const [cls, label] = map[status] || map.unknown;
  return `<span class="badge ${cls}">${label}</span>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ════════════════════════════════
// DASHBOARD
// ════════════════════════════════
async function loadDashboard() {
  try {
    const [data, processes] = await Promise.all([
      api('/dashboard'),
      api('/processes'),
    ]);
    if (!data || !processes) return;
    const { stats, sync, uptime } = data;

    document.getElementById('stat-total').textContent = stats.total || 0;
    document.getElementById('stat-synced').textContent = stats.synced || 0;
    document.getElementById('stat-updated').textContent = stats.updated || 0;
    document.getElementById('stat-unmapped').textContent = stats.unmapped || 0;
    document.getElementById('stat-notgetfly').textContent = stats.notOnGetfly || 0;
    document.getElementById('stat-errors').textContent = stats.errors || 0;

    // Update process controls
    updateProcessControls(processes);

    // Update sync status
    updateSyncStatus(sync);
    updateProgressUI(sync.progress);

    if (sync.lastSync) {
      const ls = sync.lastSync;
      document.getElementById('last-sync-time').textContent = formatTime(ls.time);
      document.getElementById('last-sync-info').innerHTML = `
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div><strong>${ls.totalPOS}</strong> <span style="color:var(--text-secondary)">POS orders</span></div>
          <div><strong>${ls.synced}</strong> <span style="color:var(--text-secondary)">checked</span></div>
          <div><strong style="color:var(--info)">${ls.updated}</strong> <span style="color:var(--text-secondary)">updated</span></div>
          <div><strong>${ls.skipped}</strong> <span style="color:var(--text-secondary)">skipped</span></div>
          <div><strong style="color:var(--error)">${ls.errors}</strong> <span style="color:var(--text-secondary)">errors</span></div>
          <div><strong>${ls.elapsed}</strong> <span style="color:var(--text-secondary)">duration</span></div>
        </div>`;
    }

    // Set days selector to current config
    const daysSelect = document.getElementById('sync-days-select');
    if (sync.daysBack !== undefined) {
      const optionExists = [...daysSelect.options].some(o => o.value == sync.daysBack);
      if (optionExists) daysSelect.value = sync.daysBack;
    }

    const history = await api('/sync/history?limit=10');
    if (history) renderSyncHistory(history);

    if (stats.unmapped > 0) {
      const badge = document.getElementById('nav-staff-badge');
      badge.textContent = stats.unmapped;
      badge.style.display = '';
    }
  } catch (err) {
    console.error('Dashboard load error:', err);
  }
}

// ── Process Control ──
function updateProcessControls(processes) {
  // Scheduler
  const schedulerToggle = document.getElementById('toggle-scheduler');
  const schedulerStatus = document.getElementById('scheduler-status');
  const schedulerDesc = document.getElementById('scheduler-desc');
  schedulerToggle.checked = processes.scheduler.active;
  if (processes.scheduler.active) {
    schedulerStatus.innerHTML = '<span class="status-dot on"></span> Running';
    schedulerDesc.textContent = `Auto sync every ${Math.round(processes.scheduler.intervalMs / 1000)}s, ${processes.scheduler.daysBack === 0 ? 'all data' : processes.scheduler.daysBack + ' days'}`;
  } else {
    schedulerStatus.innerHTML = '<span class="status-dot off"></span> Stopped';
    schedulerDesc.textContent = 'Auto sync disabled';
  }

  // Poller
  const pollerToggle = document.getElementById('toggle-poller');
  const pollerStatus = document.getElementById('poller-status');
  const pollerDesc = document.getElementById('poller-desc');
  pollerToggle.checked = processes.poller.active;
  if (processes.poller.active) {
    pollerStatus.innerHTML = '<span class="status-dot on"></span> Running';
    pollerDesc.textContent = `Checking every ${Math.round(processes.poller.intervalMs / 1000)}s`;
  } else {
    pollerStatus.innerHTML = '<span class="status-dot off"></span> Stopped';
    pollerDesc.textContent = 'Chat poller disabled';
  }

  // Server info
  if (processes.server) {
    document.getElementById('server-pid').textContent = processes.server.pid;
    document.getElementById('server-memory').textContent = formatBytes(processes.server.memory.rss);
    document.getElementById('server-uptime').textContent = formatUptime(processes.server.uptime);
  }
}

async function toggleScheduler(enabled) {
  try {
    const result = await api(enabled ? '/scheduler/start' : '/scheduler/stop', { method: 'POST' });
    if (result) {
      toast(enabled ? 'Scheduler started' : 'Scheduler stopped', 'success');
      loadDashboard();
    }
  } catch (err) {
    toast('Failed: ' + err.message, 'error');
  }
}

async function togglePoller(enabled) {
  try {
    const result = await api(enabled ? '/poller/start' : '/poller/stop', { method: 'POST' });
    if (result) {
      toast(enabled ? 'Chat poller started' : 'Chat poller stopped', 'success');
      loadDashboard();
    }
  } catch (err) {
    toast('Failed: ' + err.message, 'error');
  }
}

// ── Sync Progress ──
function updateProgressUI(progress) {
  const panel = document.getElementById('sync-progress-panel');
  if (!progress || !progress.active) {
    // Keep visible briefly after completion
    if (progress && progress.step === 'done') {
      panel.style.display = '';
      updateProgressDetails(progress);
      return;
    }
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';
  updateProgressDetails(progress);
}

function updateProgressDetails(progress) {
  // Progress bar
  const bar = document.getElementById('sync-progress-bar');
  bar.style.width = progress.percent + '%';
  bar.className = 'progress-bar' + (progress.step === 'done' ? ' done' : progress.step === 'error' ? ' error' : '');

  // Message
  document.getElementById('sync-progress-message').textContent = progress.message || '';

  // Elapsed time
  if (progress.startedAt) {
    const elapsed = Math.round((Date.now() - new Date(progress.startedAt).getTime()) / 1000);
    document.getElementById('progress-elapsed').textContent = elapsed + 's';
  }

  // Step indicators
  const steps = ['fetching-pos', 'fetching-chat', 'fetching-getfly', 'comparing'];
  const stepOrder = { 'fetching-pos': 0, 'fetching-chat': 1, 'fetching-getfly': 2, 'loading-users': 2, 'comparing': 3, 'done': 4, 'error': -1 };
  const currentIdx = stepOrder[progress.step] ?? -1;

  document.querySelectorAll('.progress-step').forEach((el) => {
    const stepName = el.dataset.step;
    const idx = stepOrder[stepName] ?? -1;
    el.classList.remove('active', 'completed');
    if (idx < currentIdx || progress.step === 'done') el.classList.add('completed');
    else if (idx === currentIdx) el.classList.add('active');
  });

  // Step values — show ⏳ for active step, value when done, keep previous value if already set
  const d = progress.details || {};
  const stepOrder = { 'fetching-pos': 0, 'fetching-chat': 1, 'fetching-getfly': 2, 'loading-users': 2, 'comparing': 3, 'done': 4, 'error': -1 };
  const currentIdx = stepOrder[progress.step] ?? -1;

  const setStepVal = (elId, stepName, valueFn, loadingText = '⏳ Loading...') => {
    const el = document.getElementById(elId);
    if (!el) return;
    const idx = stepOrder[stepName] ?? -1;
    if (valueFn()) {
      el.textContent = valueFn();          // value available → show it
    } else if (idx === currentIdx) {
      el.innerHTML = `<span style="opacity:0.6">${loadingText}</span>`;  // active step → spinner
    }
    // past/future with no value → keep whatever was there
  };

  setStepVal('step-pos', 'fetching-pos',
    () => {
      if (d.posTotal !== undefined) return `${d.posRelevant || 0} / ${d.posTotal}`;
      if (d.posLive !== undefined) return `${d.posLive.toLocaleString()}…`;
      return null;
    }, '⏳ Fetching...');
  setStepVal('step-chat', 'fetching-chat',
    () => {
      if (d.chatTotal !== undefined) return d.chatTotal.toLocaleString();
      if (d.chatLive !== undefined) return `${d.chatLive.toLocaleString()}…`;
      return null;
    }, '⏳ Fetching...');
  setStepVal('step-getfly', 'fetching-getfly',
    () => {
      if (d.getflyTotal !== undefined) return d.getflyTotal.toLocaleString();
      if (d.getflyLive !== undefined) return `${d.getflyLive.toLocaleString()}…`;
      return null;
    }, '⏳ Fetching...');
  setStepVal('step-compare', 'comparing',
    () => d.processed !== undefined ? `${d.processed}/${d.compareTotal || '?'} (${d.updated || 0} ✓)` : null, '⏳ Comparing...');
}

// ── Sync Status (sidebar) ──
function updateSyncStatus(sync) {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-status-text');
  const btn = document.getElementById('btn-sync-now');
  if (sync.isRunning) {
    dot.className = 'sync-dot running';
    text.textContent = 'Syncing...';
    if (btn) btn.disabled = true;
  } else {
    dot.className = 'sync-dot';
    text.textContent = sync.lastSync ? `Last: ${formatTime(sync.lastSync.time)}` : 'Idle';
    if (btn) btn.disabled = false;
  }
}

function renderSyncHistory(history) {
  const body = document.getElementById('sync-history-body');
  if (!history || history.length === 0) {
    body.innerHTML = '<div class="empty-state"><p>No sync history</p></div>';
    return;
  }
  body.innerHTML = history.map((h) => `
    <div class="history-item">
      <span class="history-time">${formatTime(h.time)}</span>
      <div class="history-stats">
        <span class="history-stat"><span class="dot" style="background:var(--text-secondary)"></span> ${h.synced} checked</span>
        <span class="history-stat"><span class="dot" style="background:var(--info)"></span> ${h.updated} updated</span>
        <span class="history-stat"><span class="dot" style="background:var(--warning)"></span> ${h.skipped} skipped</span>
        <span class="history-stat"><span class="dot" style="background:var(--error)"></span> ${h.errors} errors</span>
        <span style="color:var(--text-secondary)">${h.elapsed}</span>
      </div>
    </div>`).join('');
}

async function triggerSync() {
  try {
    const btn = document.getElementById('btn-sync-now');
    const days = parseInt(document.getElementById('sync-days-select').value);
    btn.disabled = true;
    btn.innerHTML = '&#x23F3; Syncing...';
    toast(`Sync started (${days === 0 ? 'all data' : days + ' days'})...`, 'info');
    await api('/sync/trigger', { method: 'POST', body: JSON.stringify({ days }) });
    // SSE will handle the progress updates automatically
  } catch (err) {
    toast('Sync failed: ' + err.message, 'error');
    const btn = document.getElementById('btn-sync-now');
    if (btn) { btn.disabled = false; btn.innerHTML = '&#x1F504; Sync Now'; }
  }
}

// ════════════════════════════════
// ORDERS
// ════════════════════════════════
function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { ordersPage = 1; refreshOrders(); }, 400);
}

async function refreshOrders() {
  try {
    const search = document.getElementById('order-search')?.value || '';
    const status = document.getElementById('order-status-filter')?.value || 'all';
    const data = await api(`/orders?page=${ordersPage}&pageSize=20&search=${encodeURIComponent(search)}&status=${status}`);
    if (data) renderOrders(data);
  } catch (err) { console.error('Orders load error:', err); }
}

function renderOrders(data) {
  const tbody = document.getElementById('orders-tbody');
  const { orders, total, page, pageSize } = data;
  if (!orders || orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><p>No orders found</p></td></tr>';
    document.getElementById('orders-pagination').style.display = 'none';
    return;
  }
  tbody.innerHTML = orders.map((o) => `
    <tr>
      <td><strong>${escapeHtml(o.orderCode)}</strong></td>
      <td>${escapeHtml(o.customerName)}</td>
      <td>${escapeHtml(o.customerPhone || '-')}</td>
      <td>${o.chatAssignee ? escapeHtml(o.chatAssignee) : '<span style="color:var(--text-secondary)">N/A</span>'}</td>
      <td>${o.getflyAssignee ? escapeHtml(o.getflyAssignee) : '<span style="color:var(--text-secondary)">N/A</span>'}</td>
      <td>${statusBadge(o.status)}</td>
    </tr>`).join('');
  const totalPages = Math.ceil(total / pageSize);
  document.getElementById('orders-pagination').style.display = 'flex';
  document.getElementById('orders-page-info').textContent = `Page ${page} of ${totalPages} (${total} orders)`;
  document.getElementById('btn-prev').disabled = page <= 1;
  document.getElementById('btn-next').disabled = page >= totalPages;
}

function changePage(delta) {
  ordersPage += delta;
  if (ordersPage < 1) ordersPage = 1;
  refreshOrders();
}

// ════════════════════════════════
// STAFF
// ════════════════════════════════
async function refreshStaff() {
  try {
    const data = await api('/staff');
    if (!data) return;
    renderUnmapped(data.unmapped);
    renderGetflyUsers(data.getflyUsers);
  } catch (err) { console.error('Staff load error:', err); }
}

function renderUnmapped(unmapped) {
  const tbody = document.getElementById('unmapped-tbody');
  if (!unmapped || unmapped.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:24px;color:var(--success)">&#x2705; All staff mapped!</td></tr>';
    return;
  }
  tbody.innerHTML = unmapped.map((u) => `
    <tr>
      <td><strong>${escapeHtml(u.name)}</strong></td>
      <td>${u.email ? escapeHtml(u.email) : '<span style="color:var(--text-secondary)">No email</span>'}</td>
      <td><span class="badge badge-unmapped">${u.orderCount} orders</span></td>
    </tr>`).join('');
}

function renderGetflyUsers(users) {
  const tbody = document.getElementById('getfly-users-tbody');
  if (!users || users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state"><p>No users found</p></td></tr>';
    return;
  }
  tbody.innerHTML = users.map((u) => `
    <tr>
      <td>${u.userId}</td>
      <td><strong>${escapeHtml(u.name)}</strong></td>
      <td>${u.email ? escapeHtml(u.email) : '-'}</td>
      <td>${u.dept ? escapeHtml(u.dept) : '-'}</td>
    </tr>`).join('');
}

// ════════════════════════════════
// SETTINGS
// ════════════════════════════════
async function loadConfig() {
  try {
    const cfg = await api('/config');
    if (!cfg) return;

    document.getElementById('cfg-sync-interval').value = Math.round(cfg.syncInterval / 1000);
    document.getElementById('cfg-sync-days').value = cfg.syncDays;
    document.getElementById('cfg-chat-poll').value = Math.round(cfg.chatPollInterval / 1000);
    document.getElementById('cfg-pos-api-key').value = cfg.pancakePosApiKey || '';
    document.getElementById('cfg-pos-base-url').value = cfg.pancakePosBaseUrl || '';
    document.getElementById('cfg-pos-shop-id').value = cfg.pancakeShopId || '';
    document.getElementById('cfg-chat-token').value = cfg.pancakeChatPageToken || '';
    document.getElementById('cfg-chat-base-url').value = cfg.pancakeChatBaseUrl || '';
    document.getElementById('cfg-chat-page-id').value = cfg.pancakeChatPageId || '';
    document.getElementById('cfg-getfly-api-key').value = cfg.getflyApiKey || '';
    document.getElementById('cfg-getfly-base-url').value = cfg.getflyBaseUrl || '';
    document.getElementById('cfg-webhook-secret').value = cfg.webhookSecret || '';
    document.getElementById('cfg-webhook-url').value = cfg.webhookUrl || '';
  } catch (err) { console.error('Config load error:', err); }
}

async function saveSection(section) {
  const body = {};
  let sectionId = section;

  switch (section) {
    case 'pos': {
      const key = document.getElementById('cfg-pos-api-key').value;
      if (key) body.pancakePosApiKey = key;
      body.pancakePosBaseUrl = document.getElementById('cfg-pos-base-url').value;
      body.pancakeShopId = document.getElementById('cfg-pos-shop-id').value;
      break;
    }
    case 'chat': {
      const token = document.getElementById('cfg-chat-token').value;
      if (token) body.pancakeChatPageToken = token;
      body.pancakeChatBaseUrl = document.getElementById('cfg-chat-base-url').value;
      body.pancakeChatPageId = document.getElementById('cfg-chat-page-id').value;
      break;
    }
    case 'getfly': {
      const key = document.getElementById('cfg-getfly-api-key').value;
      if (key) body.getflyApiKey = key;
      body.getflyBaseUrl = document.getElementById('cfg-getfly-base-url').value;
      break;
    }
    case 'sync': {
      body.syncInterval = parseInt(document.getElementById('cfg-sync-interval').value) * 1000;
      body.syncDays = parseInt(document.getElementById('cfg-sync-days').value);
      body.chatPollInterval = parseInt(document.getElementById('cfg-chat-poll').value) * 1000;
      break;
    }
    case 'webhook': {
      const secret = document.getElementById('cfg-webhook-secret').value;
      if (secret) body.webhookSecret = secret;
      break;
    }
  }

  const el = document.getElementById(`save-result-${sectionId}`);
  if (el) { el.className = 'save-result loading'; el.textContent = 'Saving...'; el.style.display = 'block'; }

  try {
    const result = await api('/config', { method: 'PUT', body: JSON.stringify(body) });
    if (result && !result.error) {
      showSaveResult(sectionId, true, `Saved! (${result.keys?.length || 0} keys updated)`);
      toast('Saved!', 'success');
      loadConfig();
    } else {
      showSaveResult(sectionId, false, result?.error || 'Save failed');
      toast(result?.error || 'Save failed', 'error');
    }
  } catch (err) {
    showSaveResult(sectionId, false, 'Error: ' + err.message);
    toast('Save failed: ' + err.message, 'error');
  }
}

async function testConnection(service) {
  const el = document.getElementById(`test-${service}`);
  el.className = 'test-result loading';
  el.style.display = 'block';
  el.textContent = 'Testing connection...';
  try {
    const result = await api(`/config/test-${service}`, { method: 'POST' });
    if (!result) return;
    el.className = `test-result ${result.success ? 'success' : 'error'}`;
    el.textContent = result.success ? `OK: ${result.message}` : `Failed: ${result.message}`;
  } catch (err) {
    el.className = 'test-result error';
    el.textContent = 'Connection failed: ' + err.message;
  }
}

function copyWebhookUrl() {
  const input = document.getElementById('cfg-webhook-url');
  navigator.clipboard.writeText(input.value).then(() => toast('Webhook URL copied!', 'success'));
}

async function changePassword() {
  const current = document.getElementById('cfg-current-pass').value;
  const newPass = document.getElementById('cfg-new-pass').value;
  if (!current || !newPass) { showSaveResult('password', false, 'Please fill in both fields'); return; }

  const el = document.getElementById('save-result-password');
  if (el) { el.className = 'save-result loading'; el.textContent = 'Changing...'; el.style.display = 'block'; }

  try {
    const res = await fetch('/api/config/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: newPass }),
    });
    const data = await res.json();
    if (res.ok) {
      showSaveResult('password', true, 'Password changed!');
      toast('Password changed!', 'success');
      document.getElementById('cfg-current-pass').value = '';
      document.getElementById('cfg-new-pass').value = '';
    } else {
      showSaveResult('password', false, data.error || 'Failed');
    }
  } catch (err) {
    showSaveResult('password', false, 'Error: ' + err.message);
  }
}

// ════════════════════════════════
// LOGS
// ════════════════════════════════
async function refreshLogs() {
  try {
    const filter = document.getElementById('log-filter')?.value || '';
    const levelFilter = document.getElementById('log-level-filter')?.value || '';
    const combinedFilter = [filter, levelFilter].filter(Boolean).join(' ');
    const logs = await api(`/logs?limit=300&filter=${encodeURIComponent(combinedFilter)}`);
    if (logs) renderLogs(logs);
  } catch (err) { console.error('Logs load error:', err); }
}

function renderLogs(logs) {
  const container = document.getElementById('log-container');
  if (!logs || logs.length === 0) {
    container.innerHTML = '<div style="color:#64748B;padding:20px;text-align:center">No logs</div>';
    return;
  }
  container.innerHTML = logs.map((l) =>
    `<div class="log-entry"><span class="log-time">${l.time?.substring(11, 19) || ''}</span> <span class="log-level-${l.level}">[${l.level}]</span> <span class="log-tag">[${l.tag}]</span> ${escapeHtml(l.message)}</div>`
  ).join('');
}

function startLogAutoRefresh() {
  stopLogAutoRefresh();
  logAutoTimer = setInterval(() => {
    if (document.getElementById('log-auto-refresh')?.checked) refreshLogs();
  }, 5000);
}

function stopLogAutoRefresh() {
  if (logAutoTimer) { clearInterval(logAutoTimer); logAutoTimer = null; }
}

// ════════════════════════════════
// SSE Real-time
// ════════════════════════════════
let wasRunning = false;

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Update sync status in sidebar
      updateSyncStatus(data.sync);

      // Update progress bar (only on dashboard)
      if (data.progress) {
        updateProgressUI(data.progress);
      }

      // Update badges
      if (data.stats) {
        const badge = document.getElementById('nav-staff-badge');
        if (data.stats.unmapped > 0) { badge.textContent = data.stats.unmapped; badge.style.display = ''; }
        else { badge.style.display = 'none'; }

        const orderBadge = document.getElementById('nav-orders-badge');
        if (data.stats.updated > 0) { orderBadge.textContent = data.stats.updated; orderBadge.style.display = ''; }
        else { orderBadge.style.display = 'none'; }
      }

      // Update server info
      if (data.server) {
        const memEl = document.getElementById('server-memory');
        const upEl = document.getElementById('server-uptime');
        if (memEl) memEl.textContent = data.server.memoryMB + ' MB';
        if (upEl) upEl.textContent = formatUptime(data.server.uptime);
      }

      // Update process toggles from poller data
      if (data.poller) {
        const pollerToggle = document.getElementById('toggle-poller');
        if (pollerToggle && pollerToggle !== document.activeElement) {
          pollerToggle.checked = data.poller.active;
        }
      }
      if (data.sync) {
        const schedulerToggle = document.getElementById('toggle-scheduler');
        if (schedulerToggle && schedulerToggle !== document.activeElement) {
          schedulerToggle.checked = data.sync.schedulerActive;
        }
      }

      // Sync completed detection - refresh dashboard data
      if (wasRunning && !data.sync.isRunning) {
        const btn = document.getElementById('btn-sync-now');
        if (btn) { btn.disabled = false; btn.innerHTML = '&#x1F504; Sync Now'; }
        toast('Sync complete!', 'success');
        if (currentPage === 'dashboard') {
          setTimeout(loadDashboard, 1000);
        }
      }
      wasRunning = data.sync.isRunning;

      // Sync started detection
      if (data.sync.isRunning) {
        const btn = document.getElementById('btn-sync-now');
        if (btn) { btn.disabled = true; btn.innerHTML = '&#x23F3; Syncing...'; }
      }
    } catch (e) { /* ignore parse errors */ }
  };
  es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
}

// ── Init ──
loadDashboard();
connectSSE();
