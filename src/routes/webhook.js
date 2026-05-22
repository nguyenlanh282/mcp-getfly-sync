const express = require('express');
const { parseWebhookPayload } = require('../services/pancakePOS');
const pancakeChat = require('../services/pancakeChat');
const getfly = require('../services/getfly');
const staffMapper = require('../utils/staffMapper');
const orderStore = require('../utils/orderStore');
const config = require('../config');
const log = require('../utils/logger');

const router = express.Router();
const TAG = 'Webhook';

const recentWebhooks = [];

// ── Simple queue: xử lý tuần tự, tránh 429 khi nhiều webhook đến cùng lúc ──
const webhookQueue = [];
let queueRunning = false;

async function enqueueWebhook(payload) {
  webhookQueue.push(payload);
  if (!queueRunning) drainQueue();
}

async function drainQueue() {
  if (queueRunning || webhookQueue.length === 0) return;
  queueRunning = true;
  while (webhookQueue.length > 0) {
    const payload = webhookQueue.shift();
    try {
      await processNewOrder(payload);
    } catch (err) {
      log.error(TAG, `Failed to process ${payload.orderCode}:`, { error: err.message });
    }
    // Delay 1s giữa các webhook để tránh rate limit Getfly
    if (webhookQueue.length > 0) await sleep(1000);
  }
  queueRunning = false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Retry wrapper cho Getfly 429
async function withRateLimit(fn, maxRetries = 3) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.response?.status === 429;
      if (!is429 || i === maxRetries) throw err;
      const delay = 2000 * i; // 2s, 4s, 6s
      log.warn(TAG, `Getfly rate limited (429), retry ${i}/${maxRetries} in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }
}

// Webhook authentication middleware
function verifyWebhook(req, res, next) {
  const secret = config.webhookSecret;
  if (!secret) return next();

  const fromQuery = req.query.secret;
  const fromHeader = req.headers['x-webhook-secret'];
  const fromAuth = (req.headers.authorization || '').replace('Bearer ', '');

  if (fromQuery === secret || fromHeader === secret || fromAuth === secret) {
    return next();
  }

  log.warn(TAG, `Unauthorized webhook attempt from ${req.ip}`);
  return res.status(401).json({ error: 'Unauthorized: invalid webhook secret' });
}

router.post('/pancake-pos', verifyWebhook, async (req, res) => {
  try {
    const entry = { time: new Date().toISOString(), body: req.body };
    recentWebhooks.push(entry);
    if (recentWebhooks.length > 20) recentWebhooks.shift();

    const payload = parseWebhookPayload(req.body);
    log.info(TAG, `Order ${payload.orderCode} | ${payload.customerName} | conv: ${payload.conversationId}`);

    // Trả lời Pancake ngay (tránh timeout), xử lý bất đồng bộ qua queue
    res.status(200).json({ success: true });

    enqueueWebhook(payload);
  } catch (err) {
    log.error(TAG, 'Webhook error:', { error: err.message });
    res.status(400).json({ error: 'Invalid payload' });
  }
});

router.get('/logs', (req, res) => {
  res.json(recentWebhooks);
});

async function processNewOrder(payload) {
  const { orderCode, conversationId, customerPhone, customerName } = payload;

  if (!conversationId) {
    log.warn(TAG, `Order ${orderCode} has no conversation_id, skipping`);
    return;
  }

  // Step 1: Get conversation from Pancake Chat
  log.info(TAG, `Looking up conversation ${conversationId} on Pancake Chat...`);
  const conversation = await pancakeChat.getConversationById(conversationId);

  if (!conversation || !conversation.assigneeId) {
    log.warn(TAG, `Conversation ${conversationId} not found or no assignee`);
    return;
  }

  log.info(TAG, `Chat assignee: ${conversation.assigneeName} (${conversation.assigneeEmail})`);

  // Step 2: Map to Getfly user
  const getflyUser = await staffMapper.findGetflyUser(conversation.assigneeName, conversation.assigneeEmail);

  if (!getflyUser) {
    log.warn(TAG, `No Getfly match for: ${conversation.assigneeName}`);
    orderStore.set(orderCode, {
      conversationId,
      assigneeId: conversation.assigneeId,
      assigneeName: conversation.assigneeName,
      getflyUserId: null,
    });
    return;
  }

  // Step 3: Assign on Getfly (with rate limit retry)
  try {
    await withRateLimit(() => getfly.assignOrderToUser(orderCode, getflyUser.user_id));
    log.info(TAG, `Order ${orderCode} -> ${getflyUser.contact_name} (user_id: ${getflyUser.user_id}) on Getfly`);
  } catch (err) {
    log.warn(TAG, `Getfly assign failed: ${err.message}`);
  }

  // Step 4: Update account manager
  try {
    let accountId = null;

    const gfOrder = await withRateLimit(() => getfly.findOrderByCode(orderCode));
    if (gfOrder && gfOrder.account_id) {
      accountId = gfOrder.account_id;
    } else if (customerPhone) {
      const account = await withRateLimit(() => getfly.findAccountByPhone(customerPhone));
      if (account) accountId = account.id;
    }

    if (accountId) {
      await withRateLimit(() => getfly.changeAccountManager(accountId, getflyUser.user_id));
      log.info(TAG, `Account ${accountId} manager -> ${getflyUser.contact_name}`);
    } else {
      log.warn(TAG, `No Getfly account found for order ${orderCode}`);
    }
  } catch (err) {
    log.warn(TAG, `Account manager update failed: ${err.message}`);
  }

  // Save mapping
  orderStore.set(orderCode, {
    conversationId,
    assigneeId: conversation.assigneeId,
    assigneeName: conversation.assigneeName,
    getflyUserId: getflyUser.user_id,
  });
}

module.exports = router;
