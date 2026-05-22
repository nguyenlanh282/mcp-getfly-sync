const pancakeChat = require('../services/pancakeChat');
const getfly = require('../services/getfly');
const staffMapper = require('../utils/staffMapper');
const orderStore = require('../utils/orderStore');
const log = require('../utils/logger');

const TAG = 'ChatPoller';

async function checkAssignmentChanges() {
  const tracked = orderStore.getAllWithConversation();
  if (tracked.length === 0) {
    log.debug(TAG, 'No tracked orders to check');
    return;
  }

  log.info(TAG, `Checking ${tracked.length} tracked conversations for assignment changes...`);

  // Batch fetch conversations
  const convIds = tracked.map((t) => t.conversationId);
  const conversations = await pancakeChat.getMultipleConversations(convIds);

  for (const order of tracked) {
    try {
      const conv = conversations.get(order.conversationId);
      if (!conv || !conv.assigneeId) continue;

      // Check if assignee changed
      if (conv.assigneeId === order.assigneeId) continue;

      log.info(TAG, `Assignment changed for order ${order.orderCode}: ${order.assigneeName} -> ${conv.assigneeName}`);

      // Map new assignee to Getfly
      const getflyUser = await staffMapper.findGetflyUser(conv.assigneeName, conv.assigneeEmail);
      if (!getflyUser) {
        log.warn(TAG, `No Getfly match for new assignee: ${conv.assigneeName}`);
        continue;
      }

      // Update on Getfly - order assignment
      await getfly.assignOrderToUser(order.orderCode, getflyUser.user_id);
      log.info(TAG, `Order ${order.orderCode} reassigned to ${getflyUser.contact_name} (user_id: ${getflyUser.user_id})`);

      // Update account manager on customer account
      try {
        const gfOrder = await getfly.findOrderByCode(order.orderCode);
        if (gfOrder) {
          let accountId = gfOrder.account_id;
          if (!accountId && gfOrder.account_phone) {
            const account = await getfly.findAccountByPhone(gfOrder.account_phone);
            if (account) accountId = account.id;
          }
          if (accountId) {
            await getfly.changeAccountManager(accountId, getflyUser.user_id);
            log.info(TAG, `Account ${accountId} manager -> ${getflyUser.contact_name}`);
          }
        }
      } catch (accErr) {
        log.warn(TAG, `Account manager update failed for ${order.orderCode}: ${accErr.message}`);
      }

      // Update store
      orderStore.updateAssignee(order.orderCode, conv.assigneeId, conv.assigneeName, getflyUser.user_id);
    } catch (err) {
      log.error(TAG, `Error checking ${order.orderCode}:`, { error: err.message });
    }
  }
}

let pollingInterval = null;
let currentIntervalMs = null;

function start(intervalMs) {
  if (pollingInterval) return;
  currentIntervalMs = intervalMs;
  log.info(TAG, `Starting poller (interval: ${intervalMs}ms)`);

  pollingInterval = setInterval(() => {
    checkAssignmentChanges().catch((err) => {
      log.error(TAG, 'Poll error:', { error: err.message });
    });
  }, intervalMs);
}

function stop() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    log.info(TAG, 'Poller stopped');
  }
}

function getStatus() {
  return {
    active: !!pollingInterval,
    intervalMs: currentIntervalMs,
  };
}

module.exports = { start, stop, getStatus, checkAssignmentChanges };
