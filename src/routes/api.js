const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const orderSync = require('../jobs/orderSync');
const chatPoller = require('../jobs/chatPoller');
const staffMapper = require('../utils/staffMapper');
const getfly = require('../services/getfly');
const config = require('../config');
const log = require('../utils/logger');

const router = express.Router();
const ENV_PATH = path.join(__dirname, '../../.env');

// ── Dashboard ──
router.get('/dashboard', (req, res) => {
  const sync = orderSync.getStatus();
  const ordersData = orderSync.getOrders({ pageSize: 99999 });
  const unmapped = orderSync.getUnmappedStaff();

  res.json({
    sync,
    stats: ordersData.stats,
    unmappedCount: unmapped.length,
    uptime: process.uptime(),
  });
});

// ── Orders ──
router.get('/orders', (req, res) => {
  const { search, status, page = 1, pageSize = 20 } = req.query;
  const result = orderSync.getOrders({
    search,
    status,
    page: parseInt(page),
    pageSize: parseInt(pageSize),
  });
  res.json(result);
});

// ── Staff Mapping ──
router.get('/staff', async (req, res) => {
  try {
    const getflyUsers = await staffMapper.loadGetflyUsers();
    const unmapped = orderSync.getUnmappedStaff();

    res.json({
      getflyUsers: getflyUsers.map((u) => ({
        userId: u.user_id,
        name: u.contact_name,
        email: u.email || u.user_name,
        dept: u.dept_name,
      })),
      unmapped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sync ──
router.get('/sync/status', (req, res) => {
  res.json(orderSync.getStatus());
});

router.get('/sync/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(orderSync.getHistory(limit));
});

router.post('/sync/trigger', async (req, res) => {
  const status = orderSync.getStatus();
  if (status.isRunning) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }

  const days = req.body?.days !== undefined ? parseInt(req.body.days) : (parseInt(req.query.days) || config.orderSyncDays);
  res.json({ message: 'Sync started', days });

  // Run in background
  orderSync.syncAssignments(days).catch((err) => {
    log.error('API', 'Manual sync failed:', { error: err.message });
  });
});

// ── Sync Progress ──
router.get('/sync/progress', (req, res) => {
  res.json(orderSync.getProgress());
});

// ── Process Control: Scheduler ──
router.post('/scheduler/start', (req, res) => {
  if (orderSync.isSchedulerRunning()) {
    return res.json({ message: 'Scheduler already running', active: true });
  }
  const interval = config.orderSyncInterval;
  const days = config.orderSyncDays;
  orderSync.start(interval, days);
  log.info('API', `Scheduler started via web UI (interval: ${interval / 1000}s, days: ${days})`);
  res.json({ message: 'Scheduler started', active: true, interval, days });
});

router.post('/scheduler/stop', (req, res) => {
  orderSync.stop();
  log.info('API', 'Scheduler stopped via web UI');
  res.json({ message: 'Scheduler stopped', active: false });
});

// ── Process Control: Chat Poller ──
router.post('/poller/start', (req, res) => {
  const status = chatPoller.getStatus();
  if (status.active) {
    return res.json({ message: 'Poller already running', active: true });
  }
  const interval = config.chatPollInterval;
  chatPoller.start(interval);
  log.info('API', `Chat poller started via web UI (interval: ${interval / 1000}s)`);
  res.json({ message: 'Poller started', active: true, interval });
});

router.post('/poller/stop', (req, res) => {
  chatPoller.stop();
  log.info('API', 'Chat poller stopped via web UI');
  res.json({ message: 'Poller stopped', active: false });
});

// ── All Processes Status ──
router.get('/processes', (req, res) => {
  const syncStatus = orderSync.getStatus();
  const pollerStatus = chatPoller.getStatus();
  res.json({
    scheduler: {
      active: syncStatus.schedulerActive,
      intervalMs: syncStatus.intervalMs,
      daysBack: syncStatus.daysBack,
    },
    sync: {
      running: syncStatus.isRunning,
      progress: syncStatus.progress,
      lastSync: syncStatus.lastSync,
    },
    poller: pollerStatus,
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      pid: process.pid,
    },
  });
});

// ── Config (full settings) ──
router.get('/config', (req, res) => {
  res.json({
    // Sync settings
    syncInterval: config.orderSyncInterval,
    syncDays: config.orderSyncDays,
    chatPollInterval: config.chatPollInterval,

    // Pancake POS (masked)
    pancakePosApiKey: maskKey(config.pancakePOS.apiKey),
    pancakePosBaseUrl: config.pancakePOS.baseURL || '',
    pancakeShopId: config.pancakePOS.shopId || '',

    // Pancake Chat (masked)
    pancakeChatPageToken: maskKey(config.pancakeChat.pageToken),
    pancakeChatBaseUrl: config.pancakeChat.baseURL || '',
    pancakeChatPageId: config.pancakeChat.pageId || '',

    // Getfly (masked)
    getflyApiKey: maskKey(config.getfly.apiKey),
    getflyBaseUrl: config.getfly.baseURL || '',

    // Webhook (masked)
    webhookSecret: maskKey(config.webhookSecret),
    webhookUrl: `https://sync.tripower.vn/webhook/pancake-pos?secret=${config.webhookSecret}`,

    // Server
    port: config.port,
  });
});

// Full config update
router.put('/config', (req, res) => {
  const updates = req.body;
  const envUpdates = {};

  // Sync settings
  if (updates.syncInterval !== undefined) {
    const ms = parseInt(updates.syncInterval);
    if (ms < 60000) return res.status(400).json({ error: 'Minimum sync interval: 60 seconds' });
    config.orderSyncInterval = ms;
    envUpdates.ORDER_SYNC_INTERVAL = String(ms);
  }
  if (updates.syncDays !== undefined) {
    const d = parseInt(updates.syncDays);
    if (d < 0 || d > 365) return res.status(400).json({ error: 'Days must be 0-365 (0 = all)' });
    config.orderSyncDays = d;
    envUpdates.ORDER_SYNC_DAYS = String(d);
  }
  if (updates.chatPollInterval !== undefined) {
    const ms = parseInt(updates.chatPollInterval);
    if (ms < 10000) return res.status(400).json({ error: 'Min chat poll: 10 seconds' });
    config.chatPollInterval = ms;
    envUpdates.CHAT_POLL_INTERVAL = String(ms);
  }

  // Pancake POS
  if (updates.pancakePosApiKey) {
    config.pancakePOS.apiKey = updates.pancakePosApiKey;
    envUpdates.PANCAKE_POS_API_KEY = updates.pancakePosApiKey;
  }
  if (updates.pancakePosBaseUrl) {
    config.pancakePOS.baseURL = updates.pancakePosBaseUrl;
    envUpdates.PANCAKE_POS_BASE_URL = updates.pancakePosBaseUrl;
  }
  if (updates.pancakeShopId) {
    config.pancakePOS.shopId = updates.pancakeShopId;
    envUpdates.PANCAKE_SHOP_ID = updates.pancakeShopId;
  }

  // Pancake Chat
  if (updates.pancakeChatPageToken) {
    config.pancakeChat.pageToken = updates.pancakeChatPageToken;
    envUpdates.PANCAKE_CHAT_PAGE_TOKEN = updates.pancakeChatPageToken;
  }
  if (updates.pancakeChatBaseUrl) {
    config.pancakeChat.baseURL = updates.pancakeChatBaseUrl;
    envUpdates.PANCAKE_CHAT_BASE_URL = updates.pancakeChatBaseUrl;
  }
  if (updates.pancakeChatPageId) {
    config.pancakeChat.pageId = updates.pancakeChatPageId;
    envUpdates.PANCAKE_CHAT_PAGE_ID = updates.pancakeChatPageId;
  }

  // Getfly
  if (updates.getflyApiKey) {
    config.getfly.apiKey = updates.getflyApiKey;
    envUpdates.GETFLY_API_KEY = updates.getflyApiKey;
  }
  if (updates.getflyBaseUrl) {
    config.getfly.baseURL = updates.getflyBaseUrl;
    envUpdates.GETFLY_BASE_URL = updates.getflyBaseUrl;
  }

  // Webhook Secret
  if (updates.webhookSecret) {
    config.webhookSecret = updates.webhookSecret;
    envUpdates.WEBHOOK_SECRET = updates.webhookSecret;
  }

  // Persist to .env file
  if (Object.keys(envUpdates).length > 0) {
    try {
      updateEnvFile(envUpdates);
      log.info('Config', `Updated .env: ${Object.keys(envUpdates).join(', ')}`);
    } catch (err) {
      log.warn('Config', `Failed to save .env: ${err.message}`);
    }
  }

  // Restart sync with new config
  orderSync.updateConfig(config.orderSyncInterval, config.orderSyncDays);

  res.json({ message: 'Config updated', keys: Object.keys(envUpdates) });
});

// Test connection endpoints
router.post('/config/test-pancake-pos', async (req, res) => {
  try {
    const axios = require('axios');
    const { data } = await axios.get(`${config.pancakePOS.baseURL}/shops`, {
      params: { api_key: config.pancakePOS.apiKey },
      timeout: 10000,
    });
    const shops = Array.isArray(data) ? data : data.data || [];
    res.json({ success: true, message: `OK - ${shops.length} shop(s) found` });
  } catch (err) {
    res.json({ success: false, message: err.response?.data?.message || err.message });
  }
});

router.post('/config/test-pancake-chat', async (req, res) => {
  try {
    const axios = require('axios');
    const { data } = await axios.get(
      `${config.pancakeChat.baseURL}/pages/${config.pancakeChat.pageId}/conversations`,
      {
        params: { access_token: config.pancakeChat.pageToken, page_size: 1 },
        timeout: 10000,
      }
    );
    res.json({ success: true, message: 'OK - Connected' });
  } catch (err) {
    res.json({ success: false, message: err.response?.data?.message || err.message });
  }
});

router.post('/config/test-getfly', async (req, res) => {
  try {
    const axios = require('axios');
    const { data } = await axios.get(`${config.getfly.baseURL}/api/v6.1/users`, {
      headers: { 'X-API-KEY': config.getfly.apiKey },
      params: { fields: 'user_id,contact_name' },
      timeout: 10000,
    });
    const users = data.data || [];
    res.json({ success: true, message: `OK - ${users.length} user(s)` });
  } catch (err) {
    res.json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// Change admin password
router.post('/config/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;

  // Support both plain-text (legacy) and bcrypt hashed passwords
  const isHashed = config.admin.pass.startsWith('$2');
  const currentMatch = isHashed
    ? bcrypt.compareSync(currentPassword, config.admin.pass)
    : currentPassword === config.admin.pass;

  if (!currentMatch) {
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 6 ký tự' });
  }
  const hashed = bcrypt.hashSync(newPassword, 10);
  config.admin.pass = hashed;
  try {
    updateEnvFile({ ADMIN_PASS: hashed });
    log.info('Config', 'Admin password changed (bcrypt hashed)');
  } catch (err) {
    log.warn('Config', `Failed to save password to .env: ${err.message}`);
  }
  res.json({ success: true, message: 'Password changed' });
});

// ── Logs ──
router.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const filter = req.query.filter || null;
  res.json(log.getRecentLogs(limit, filter));
});

// ── SSE for real-time updates ──
router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const sendEvent = () => {
    const syncStatus = orderSync.getStatus();
    const pollerStatus = chatPoller.getStatus();
    const data = {
      sync: syncStatus,
      poller: pollerStatus,
      // Use getStats() instead of scanning all orders for performance
      stats: orderSync.getStats(),
      progress: syncStatus.progress,
      server: {
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent();
  const interval = setInterval(sendEvent, 3000);

  req.on('close', () => clearInterval(interval));
});

// ── Helpers ──
function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return key.substring(0, 4) + '***' + key.substring(key.length - 4);
}

function updateEnvFile(updates) {
  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    content = '';
  }

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

module.exports = router;
module.exports.updateEnvFile = updateEnvFile;
