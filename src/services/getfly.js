const axios = require('axios');
const config = require('../config');
const log = require('../utils/logger');

const TAG = 'Getfly';

const client = axios.create({
  baseURL: config.getfly.baseURL,
  timeout: 30000,
  headers: {
    'X-API-KEY': config.getfly.apiKey,
    'Content-Type': 'application/json',
  },
});

// Hàm gọi lại (retry) với thời gian chờ tăng dần
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT'
        || err.code === 'ECONNABORTED' || (err.response && err.response.status >= 500);
      if (attempt === maxRetries || !isRetryable) throw err;
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
      log.warn(TAG, `Request failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getUsers() {
  const { data } = await client.get('/api/v6.1/users', {
    params: { fields: 'user_id,contact_name,user_name,dept_id,dept_name,email,contact_mobile' },
  });
  const users = data.data || [];
  log.info(TAG, `Fetched ${users.length} users`);
  return users;
}

async function getSaleOrders(params = {}) {
  const fields = 'id,order_code,assigned_user,assigned_user_name,account_id,account_phone,contact_name,status,status_label';
  const { data } = await client.get('/api/v6.1/sale_orders', {
    params: { fields, limit: 50, ...params },
  });
  return data;
}

async function findOrderByCode(orderCode) {
  // Tham số tìm kiếm trong Getfly v6.1 không còn khớp với order_code.
  // Chúng tôi tải các đơn hàng gần đây (lên đến 500) và tìm kiếm cục bộ.
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const result = await getSaleOrders({ limit: 50, offset });
    const orders = result.data || [];
    const found = orders.find((o) => o.order_code === orderCode);
    if (found) return found;
    if (!result.has_more) break;
    offset += 50;
  }
  return null;
}

/**
 * Lấy TẤT CẢ đơn hàng bán có tiền tố PANCAKE từ Getfly (có phân trang).
 * Trả về Map<orderCode, order>
 */
async function getAllPancakeOrders(onProgress = null) {
  const allOrders = new Map();
  let offset = 0;
  const pageSize = 50;
  const maxPages = 200; // 200 × 50 = 10.000 đơn tối đa

  log.info(TAG, 'Fetching all PANCAKE orders from Getfly...');

  for (let page = 0; page < maxPages; page++) {
    const { data } = await withRetry(() =>
      client.get('/api/v6.1/sale_orders', {
        params: {
          fields: 'id,order_code,assigned_user,assigned_user_name,account_id,account_phone,contact_name,status,status_label',
          limit: pageSize,
          offset,
        },
      })
    );

    const result = data || {};
    const orders = result.data || [];
    if (orders.length === 0) break;

    for (const order of orders) {
      if (order.order_code && order.order_code.startsWith('PANCAKE-')) {
        allOrders.set(order.order_code, order);
      }
    }

    // Báo cáo tiến độ sau mỗi trang
    if (onProgress) onProgress(allOrders.size, page + 1);

    if (!result.has_more) break;
    offset += pageSize;

    if ((page + 1) % 10 === 0) {
      log.info(TAG, `  ...page ${page + 1}, ${allOrders.size} PANCAKE orders so far`);
    }

    await sleep(200);
  }

  log.info(TAG, `Found ${allOrders.size} PANCAKE orders on Getfly`);
  return allOrders;
}

async function updateSaleOrder(orderCode, updateData) {
  const { data } = await client.put('/api/v6.1/sale_order', {
    current_order_code: orderCode,
    ...updateData,
  });
  log.info(TAG, `Updated order ${orderCode}`);
  return data;
}

async function assignOrderToUser(orderCode, userId) {
  return updateSaleOrder(orderCode, { assigned_user: userId });
}

async function changeAccountManager(accountId, userId) {
  const { data } = await client.put('/api/v6.1/account', {
    current_account_id: accountId,
    account_manager: userId,
  });
  log.info(TAG, `Changed account ${accountId} manager to user_id ${userId}`);
  return data;
}

async function getAccounts(params = {}) {
  const fields = 'id,account_code,account_name,phone_office,email,mgr_display_name,account_manager';
  const { data } = await client.get('/api/v6.1/accounts', {
    params: { fields, limit: 50, ...params },
  });
  return data;
}

async function findAccountByPhone(phone) {
  const result = await getAccounts({ search: phone, limit: 5 });
  const accounts = result.data || [];
  return accounts.find((a) => a.phone_office === phone) || accounts[0] || null;
}

async function findAccountById(accountId) {
  const result = await getAccounts({ search: accountId, limit: 5 });
  const accounts = result.data || [];
  return accounts.find((a) => a.id == accountId) || null;
}

module.exports = {
  getUsers,
  getSaleOrders,
  findOrderByCode,
  getAllPancakeOrders,
  updateSaleOrder,
  assignOrderToUser,
  changeAccountManager,
  getAccounts,
  findAccountByPhone,
  findAccountById,
};
