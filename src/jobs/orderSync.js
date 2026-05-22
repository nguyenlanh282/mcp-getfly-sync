const fs = require('fs');
const path = require('path');
const pancakePOS = require('../services/pancakePOS');
const pancakeChat = require('../services/pancakeChat');
const getfly = require('../services/getfly');
const staffMapper = require('../utils/staffMapper');
const config = require('../config');
const log = require('../utils/logger');

const TAG = 'OrderSync';

// ── File paths ──
const DATA_DIR = path.join(__dirname, '../../data');
const HISTORY_FILE = path.join(DATA_DIR, 'sync-history.json');
const ORDERS_FILE = path.join(DATA_DIR, 'sync-orders.json');
const UNMAPPED_FILE = path.join(DATA_DIR, 'unmapped-staff.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── State tracking ──
let syncHistory = [];
const MAX_HISTORY = 100;
let lastSyncOrders = [];
let unmappedStaff = new Map(); // name -> { name, email, orderCount }
let isRunning = false;
let syncInterval = null;   // declared early so getStatus() can safely reference it
let currentInterval = null;
let currentDays = null;

// ── Sync Progress Tracking ──
let syncProgress = {
  active: false,
  step: 'idle',
  message: 'Chờ lệnh...',
  percent: 0,
  startedAt: null,
  details: {},
};

function updateProgress(step, message, percent = 0, details = {}) {
  syncProgress = {
    active: true,
    step,
    message,
    percent: Math.min(100, Math.round(percent)),
    startedAt: syncProgress.startedAt,
    details: { ...syncProgress.details, ...details },
  };
}

function getProgress() {
  return { ...syncProgress };
}

// ── Persistence: Load ──
function loadState() {
  ensureDir();
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      syncHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      log.info(TAG, `Loaded ${syncHistory.length} sync history entries`);
    }
  } catch (err) {
    log.warn(TAG, `Failed to load sync history: ${err.message}`);
    syncHistory = [];
  }

  try {
    if (fs.existsSync(ORDERS_FILE)) {
      lastSyncOrders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
      log.info(TAG, `Loaded ${lastSyncOrders.length} cached orders`);
    }
  } catch (err) {
    log.warn(TAG, `Failed to load cached orders: ${err.message}`);
    lastSyncOrders = [];
  }

  try {
    if (fs.existsSync(UNMAPPED_FILE)) {
      const arr = JSON.parse(fs.readFileSync(UNMAPPED_FILE, 'utf-8'));
      unmappedStaff = new Map(arr.map((item) => [item.key, item]));
      log.info(TAG, `Loaded ${unmappedStaff.size} unmapped staff entries`);
    }
  } catch (err) {
    log.warn(TAG, `Failed to load unmapped staff: ${err.message}`);
    unmappedStaff = new Map();
  }
}

// ── Persistence: Save ──
function saveHistory() {
  try {
    ensureDir();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(syncHistory, null, 2), 'utf-8');
  } catch (err) {
    log.warn(TAG, `Failed to save sync history: ${err.message}`);
  }
}

function saveOrders() {
  try {
    ensureDir();
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(lastSyncOrders), 'utf-8');
  } catch (err) {
    log.warn(TAG, `Failed to save orders: ${err.message}`);
  }
}

function saveUnmapped() {
  try {
    ensureDir();
    const arr = Array.from(unmappedStaff.entries()).map(([key, val]) => ({ key, ...val }));
    fs.writeFileSync(UNMAPPED_FILE, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (err) {
    log.warn(TAG, `Failed to save unmapped staff: ${err.message}`);
  }
}

// ── Init: load saved state ──
loadState();

/**
 * Main sync: POS orders → Chat assignees → Getfly update
 */
async function syncAssignments(daysBack = 2) {
  const startTime = Date.now();
  syncProgress.startedAt = new Date().toISOString();
  syncProgress.details = {};
  log.info(TAG, `=== Starting assignment sync (last ${daysBack} days) ===`);

  const syncOrders = [];
  const newUnmapped = new Map();

  // Step 1: Fetch recent POS orders
  updateProgress('fetching-pos', 'Đang tải đơn hàng từ Pancake POS...', 5);
  const posOrders = await pancakePOS.getRecentOrders(daysBack);

  // Filter to our page's conversations
  const pageId = config.pancakeChat.pageId;
  const relevantOrders = posOrders.filter(
    (o) => o.conversation_id && o.conversation_id.startsWith(pageId + '_')
  );
  log.info(TAG, `POS orders: ${posOrders.length} total, ${relevantOrders.length} with our page conversations`);
  updateProgress('fetching-pos', `POS: ${posOrders.length} đơn, ${relevantOrders.length} liên quan`, 15, {
    posTotal: posOrders.length,
    posRelevant: relevantOrders.length,
  });

  if (relevantOrders.length === 0) {
    const result = { time: new Date().toISOString(), totalPOS: posOrders.length, synced: 0, updated: 0, skipped: 0, errors: 0, elapsed: '0s' };
    pushHistory(result);
    lastSyncOrders = [];
    saveOrders();
    return result;
  }

  // Step 2: Fetch all recent Chat conversations
  updateProgress('fetching-chat', 'Đang tải hội thoại từ Pancake Chat...', 20);
  const chatAssignments = await pancakeChat.getAllRecentConversations(daysBack);
  log.info(TAG, `Chat conversations: ${chatAssignments.size}`);
  updateProgress('fetching-chat', `Chat: ${chatAssignments.size} hội thoại`, 45, {
    chatTotal: chatAssignments.size,
  });

  // Step 3: Fetch all PANCAKE orders from Getfly
  updateProgress('fetching-getfly', 'Đang tải đơn PANCAKE từ Getfly CRM...', 50);
  const getflyOrders = await getfly.getAllPancakeOrders();
  log.info(TAG, `Getfly PANCAKE orders: ${getflyOrders.size}`);
  updateProgress('fetching-getfly', `Getfly: ${getflyOrders.size} đơn PANCAKE`, 65, {
    getflyTotal: getflyOrders.size,
  });

  // Step 4: Load Getfly users
  updateProgress('loading-users', 'Đang tải danh sách nhân viên Getfly...', 70);
  await staffMapper.loadGetflyUsers();

  // Step 5: Compare and update
  updateProgress('comparing', `Đang so sánh ${relevantOrders.length} đơn...`, 75);
  let updated = 0;
  let errors = 0;
  let skipped = 0;

  let processedCount = 0;
  for (const posOrder of relevantOrders) {
    processedCount++;
    if (processedCount % 50 === 0 || processedCount === relevantOrders.length) {
      const pct = 75 + Math.round((processedCount / relevantOrders.length) * 20);
      updateProgress('comparing', `Đang xử lý: ${processedCount}/${relevantOrders.length} đơn (${updated} cập nhật, ${errors} lỗi)`, pct, {
        processed: processedCount,
        compareTotal: relevantOrders.length,
        updated,
        errors,
        skipped,
      });
    }
    const convId = posOrder.conversation_id;
    const orderCode = `PANCAKE-${posOrder.shop_id}-${posOrder.system_id}`;
    const chatConv = chatAssignments.get(convId);
    const gfOrder = getflyOrders.get(orderCode);

    // Build order record
    const orderRecord = {
      orderCode,
      systemId: posOrder.system_id,
      customerName: posOrder.bill_full_name || 'N/A',
      customerPhone: posOrder.bill_phone_number || '',
      conversationId: convId,
      chatAssignee: chatConv?.assigneeName || null,
      chatAssigneeEmail: chatConv?.assigneeEmail || null,
      getflyAssignee: gfOrder?.assigned_user_name || null,
      getflyUserId: gfOrder?.assigned_user || null,
      onGetfly: !!gfOrder,
      status: 'unknown',
      updatedAt: posOrder.updated_at,
    };

    try {
      if (!chatConv || !chatConv.assigneeId) {
        orderRecord.status = 'no-chat-assignee';
        skipped++;
        syncOrders.push(orderRecord);
        continue;
      }

      if (!gfOrder) {
        orderRecord.status = 'not-on-getfly';
        skipped++;
        syncOrders.push(orderRecord);
        continue;
      }

      // Map Chat assignee to Getfly user
      const getflyUser = await staffMapper.findGetflyUser(chatConv.assigneeName, chatConv.assigneeEmail);
      if (!getflyUser) {
        orderRecord.status = 'unmapped-staff';
        skipped++;

        // Track unmapped staff
        const key = chatConv.assigneeEmail || chatConv.assigneeName;
        const existing = newUnmapped.get(key) || {
          name: chatConv.assigneeName,
          email: chatConv.assigneeEmail,
          orderCount: 0,
        };
        existing.orderCount++;
        newUnmapped.set(key, existing);

        syncOrders.push(orderRecord);
        continue;
      }

      orderRecord.mappedGetflyUser = getflyUser.contact_name;
      orderRecord.mappedGetflyUserId = getflyUser.user_id;

      // Check if already correct
      if (gfOrder.assigned_user === getflyUser.user_id) {
        orderRecord.status = 'synced';
        syncOrders.push(orderRecord);
        continue;
      }

      // Update order
      log.info(TAG, `Updating ${orderCode}: ${gfOrder.assigned_user_name || 'N/A'} -> ${getflyUser.contact_name} (Chat: ${chatConv.assigneeName})`);
      await getfly.assignOrderToUser(orderCode, getflyUser.user_id);

      // Update account manager
      try {
        let accountId = gfOrder.account_id;
        if (!accountId && gfOrder.account_phone) {
          const account = await getfly.findAccountByPhone(gfOrder.account_phone);
          if (account) accountId = account.id;
        }
        if (accountId) {
          await getfly.changeAccountManager(accountId, getflyUser.user_id);
          log.info(TAG, `Account ${accountId} manager -> ${getflyUser.contact_name}`);
        }
      } catch (accErr) {
        log.warn(TAG, `Account manager update failed for ${orderCode}: ${accErr.message}`);
      }

      orderRecord.status = 'updated';
      orderRecord.getflyAssignee = getflyUser.contact_name;
      orderRecord.getflyUserId = getflyUser.user_id;
      updated++;
    } catch (err) {
      orderRecord.status = 'error';
      orderRecord.error = err.message;
      errors++;
      log.error(TAG, `Error syncing ${orderCode}: ${err.message}`);
    }

    syncOrders.push(orderRecord);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(TAG, `=== Sync complete in ${elapsed}s: ${relevantOrders.length} checked, ${updated} updated, ${skipped} skipped, ${errors} errors ===`);

  // Final progress
  updateProgress('done', `Hoàn tất! ${updated} cập nhật, ${errors} lỗi (${elapsed}s)`, 100, {
    processed: relevantOrders.length,
    compareTotal: relevantOrders.length,
    updated,
    errors,
    skipped,
    elapsed,
  });

  const result = {
    time: new Date().toISOString(),
    totalPOS: posOrders.length,
    synced: relevantOrders.length,
    updated,
    skipped,
    errors,
    elapsed: `${elapsed}s`,
  };

  // Save state to memory + disk
  pushHistory(result);
  lastSyncOrders = syncOrders;
  unmappedStaff = newUnmapped;

  saveOrders();
  saveUnmapped();
  log.saveLogs();

  return result;
}

function pushHistory(result) {
  syncHistory.unshift(result);
  if (syncHistory.length > MAX_HISTORY) syncHistory.length = MAX_HISTORY;
  saveHistory();
}

// ── Public state getters ──

function getStatus() {
  return {
    isRunning,
    schedulerActive: !!syncInterval,
    intervalMs: currentInterval,
    daysBack: currentDays,
    lastSync: syncHistory[0] || null,
    historyCount: syncHistory.length,
    progress: getProgress(),
  };
}

function getHistory(limit = 20) {
  return syncHistory.slice(0, limit);
}

function getOrders(options = {}) {
  let orders = [...lastSyncOrders];
  const { search, status, page = 1, pageSize = 20 } = options;

  // Filter
  if (search) {
    const q = search.toLowerCase();
    orders = orders.filter(
      (o) =>
        o.orderCode.toLowerCase().includes(q) ||
        o.customerName.toLowerCase().includes(q) ||
        (o.customerPhone && o.customerPhone.includes(q)) ||
        (o.chatAssignee && o.chatAssignee.toLowerCase().includes(q)) ||
        (o.getflyAssignee && o.getflyAssignee.toLowerCase().includes(q))
    );
  }

  if (status && status !== 'all') {
    orders = orders.filter((o) => o.status === status);
  }

  // Stats
  const stats = {
    total: lastSyncOrders.length,
    synced: lastSyncOrders.filter((o) => o.status === 'synced').length,
    updated: lastSyncOrders.filter((o) => o.status === 'updated').length,
    unmapped: lastSyncOrders.filter((o) => o.status === 'unmapped-staff').length,
    notOnGetfly: lastSyncOrders.filter((o) => o.status === 'not-on-getfly').length,
    noAssignee: lastSyncOrders.filter((o) => o.status === 'no-chat-assignee').length,
    errors: lastSyncOrders.filter((o) => o.status === 'error').length,
  };

  // Paginate
  const totalFiltered = orders.length;
  const start = (page - 1) * pageSize;
  const paged = orders.slice(start, start + pageSize);

  return { orders: paged, total: totalFiltered, page, pageSize, stats };
}

function getStats() {
  return {
    total: lastSyncOrders.length,
    synced: lastSyncOrders.filter((o) => o.status === 'synced').length,
    updated: lastSyncOrders.filter((o) => o.status === 'updated').length,
    unmapped: lastSyncOrders.filter((o) => o.status === 'unmapped-staff').length,
    notOnGetfly: lastSyncOrders.filter((o) => o.status === 'not-on-getfly').length,
    noAssignee: lastSyncOrders.filter((o) => o.status === 'no-chat-assignee').length,
    errors: lastSyncOrders.filter((o) => o.status === 'error').length,
  };
}

function getUnmappedStaff() {
  return Array.from(unmappedStaff.values()).sort((a, b) => b.orderCount - a.orderCount);
}

// ── Scheduler ──
// (syncInterval already declared at top of module)

function start(intervalMs, daysBack = 2) {
  if (syncInterval) return;
  currentInterval = intervalMs;
  currentDays = daysBack;
  log.info(TAG, `Starting order sync (interval: ${intervalMs / 1000}s, range: ${daysBack} days)`);

  runSync(daysBack);
  syncInterval = setInterval(() => runSync(daysBack), intervalMs);
}

async function runSync(daysBack) {
  if (isRunning) {
    log.warn(TAG, 'Sync already in progress, skipping');
    return;
  }
  isRunning = true;
  try {
    await syncAssignments(daysBack);
  } catch (err) {
    log.error(TAG, 'Sync failed:', { error: err.message });
    syncProgress = { active: false, step: 'error', message: `Lỗi: ${err.message}`, percent: 0, startedAt: null, details: {} };
  } finally {
    isRunning = false;
    // Keep progress visible for 10s after completion, then reset
    setTimeout(() => {
      if (!isRunning) {
        syncProgress = { active: false, step: 'idle', message: 'Chờ lệnh...', percent: 0, startedAt: null, details: {} };
      }
    }, 10000);
  }
}

function isSchedulerRunning() {
  return !!syncInterval;
}

function stop() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    log.info(TAG, 'Order sync stopped');
  }
}

function updateConfig(intervalMs, daysBack) {
  stop();
  currentInterval = intervalMs;
  currentDays = daysBack;
  start(intervalMs, daysBack);
  log.info(TAG, `Config updated: interval=${intervalMs}ms, days=${daysBack}`);
}

module.exports = {
  syncAssignments,
  start,
  stop,
  updateConfig,
  getStatus,
  getProgress,
  getHistory,
  getOrders,
  getStats,
  getUnmappedStaff,
  isSchedulerRunning,
};
