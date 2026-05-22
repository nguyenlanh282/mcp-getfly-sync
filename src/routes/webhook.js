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

// Webhook authentication middleware
function verifyWebhook(req, res, next) {
  const secret = config.webhookSecret;
  if (!secret) return next(); // no secret configured, allow all

  // Support multiple auth methods:
  // 1. Query param: ?secret=xxx
  // 2. Header: X-Webhook-Secret: xxx
  // 3. Header: Authorization: Bearer xxx
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

    res.status(200).json({ success: true });

    processNewOrder(payload).catch((err) => {
      log.error(TAG, `Failed to process ${payload.orderCode}:`, { error: err.message });
    });
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

  // Step 1: Get conversation from Pancake Chat by conversation_id
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
    // Still save mapping so poller can retry later
    orderStore.set(orderCode, {
      conversationId,
      assigneeId: conversation.assigneeId,
      assigneeName: conversation.assigneeName,
      getflyUserId: null,
    });
    return;
  }

  // Step 3: Assign on Getfly (order + account manager)
  try {
    await getfly.assignOrderToUser(orderCode, getflyUser.user_id);
    log.info(TAG, `Order ${orderCode} -> ${getflyUser.contact_name} (user_id: ${getflyUser.user_id}) on Getfly`);
  } catch (err) {
    log.warn(TAG, `Getfly assign failed (order may not be synced yet): ${err.message}`);
  }

  // Step 4: Update account manager on customer account
  try {
    let accountId = null;

    // Try finding account via order on Getfly first
    const gfOrder = await getfly.findOrderByCode(orderCode);
    if (gfOrder && gfOrder.account_id) {
      accountId = gfOrder.account_id;
    } else if (customerPhone) {
      // Fallback: find account by phone
      const account = await getfly.findAccountByPhone(customerPhone);
      if (account) accountId = account.id;
    }

    if (accountId) {
      await getfly.changeAccountManager(accountId, getflyUser.user_id);
      log.info(TAG, `Account ${accountId} manager -> ${getflyUser.contact_name}`);
    } else {
      log.warn(TAG, `No Getfly account found for order ${orderCode}`);
    }
  } catch (err) {
    log.warn(TAG, `Account manager update failed: ${err.message}`);
  }

  // Save mapping for future polling
  orderStore.set(orderCode, {
    conversationId,
    assigneeId: conversation.assigneeId,
    assigneeName: conversation.assigneeName,
    getflyUserId: getflyUser.user_id,
  });
}

module.exports = router;
