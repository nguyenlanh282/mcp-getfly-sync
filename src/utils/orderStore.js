const fs = require('fs');
const path = require('path');
const log = require('./logger');

const TAG = 'OrderStore';
const STORE_PATH = path.join(__dirname, '../../data/orders.json');

// { orderCode: { conversationId, assigneeId, assigneeName, getflyUserId, updatedAt } }
let store = {};

function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    ensureDir();
    if (fs.existsSync(STORE_PATH)) {
      store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      log.info(TAG, `Loaded ${Object.keys(store).length} order mappings`);
    }
  } catch (err) {
    log.error(TAG, 'Failed to load store:', { error: err.message });
    store = {};
  }
}

function save() {
  try {
    ensureDir();
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    log.error(TAG, 'Failed to save store:', { error: err.message });
  }
}

function set(orderCode, data) {
  store[orderCode] = { ...data, updatedAt: new Date().toISOString() };
  save();
}

function get(orderCode) {
  return store[orderCode] || null;
}

function getAllWithConversation() {
  return Object.entries(store)
    .filter(([, v]) => v.conversationId)
    .map(([orderCode, v]) => ({ orderCode, ...v }));
}

function updateAssignee(orderCode, assigneeId, assigneeName, getflyUserId) {
  if (store[orderCode]) {
    store[orderCode].assigneeId = assigneeId;
    store[orderCode].assigneeName = assigneeName;
    store[orderCode].getflyUserId = getflyUserId;
    store[orderCode].updatedAt = new Date().toISOString();
    save();
  }
}

// Init
load();

module.exports = { set, get, getAllWithConversation, updateAssignee, load };
