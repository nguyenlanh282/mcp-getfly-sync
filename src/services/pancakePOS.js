const axios = require('axios');
const config = require('../config');
const log = require('../utils/logger');

const TAG = 'PancakePOS';

const client = axios.create({
  baseURL: config.pancakePOS.baseURL,
  params: { api_key: config.pancakePOS.apiKey },
  timeout: 30000,
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

async function getShops() {
  const { data } = await client.get('/shops');
  log.info(TAG, `Fetched ${data.length || 0} shops`);
  return data;
}

async function getOrder(orderId) {
  const shopId = config.pancakePOS.shopId;
  const { data } = await client.get(`/shops/${shopId}/orders/${orderId}`);
  return data;
}

async function getOrders(params = {}) {
  const shopId = config.pancakePOS.shopId;
  const { data } = await client.get(`/shops/${shopId}/orders`, { params });
  return data;
}

function parseWebhookPayload(body) {
  const order = body.order || body.data || body;
  const shopId = order.shop_id || config.pancakePOS.shopId;
  const orderId = order.system_id || order.id;

  // Định dạng mã đơn hàng Getfly: PANCAKE-{shop_id}-{order_id}
  const orderCode = order.display_id
    || order.order_code
    || (shopId && orderId ? `PANCAKE-${shopId}-${orderId}` : null);

  // Trích xuất số điện thoại khách hàng từ hội thoại hoặc đối tượng khách hàng
  const customer = order.customer || {};
  const phones = customer.phone_numbers || [];

  return {
    orderId,
    orderCode,
    shopId,
    eventType: order.event_type || 'create',
    customerId: order.customer_id || customer.customer_id,
    customerName: order.bill_full_name || customer.name,
    customerPhone: order.bill_phone_number || phones[0],
    customerEmail: order.bill_email || (customer.emails && customer.emails[0]),
    conversationId: order.conversation_id,
    assignedSellerId: order.assigning_seller_id,
    assignedSellerName: order.assigning_seller?.name,
    pageId: order.page_id,
    status: order.status,
    raw: order,
  };
}

/**
 * Lấy TẤT CẢ các đơn hàng gần đây từ POS (trong N ngày qua).
 * Phân trang qua các kết quả, dừng khi đơn hàng cũ hơn thời điểm cắt (cutoff).
 */
async function getRecentOrders(daysBack = 2, onProgress = null) {
  const shopId = config.pancakePOS.shopId;
  const syncAll = daysBack === 0;
  const cutoff = syncAll ? null : new Date(Date.now() - daysBack * 86400000);
  const allOrders = [];
  let pageNumber = 1;
  const maxPages = 500;

  log.info(TAG, syncAll ? 'Fetching ALL orders...' : `Fetching recent orders (last ${daysBack} days)...`);

  while (pageNumber <= maxPages) {
    const { data } = await withRetry(() =>
      client.get(`/shops/${shopId}/orders`, {
        params: { page_size: 50, page_number: pageNumber },
      })
    );

    const result = data || {};
    const orders = result.data || [];
    if (orders.length === 0) break;

    if (syncAll) {
      allOrders.push(...orders);
    } else {
      let reachedCutoff = false;
      for (const order of orders) {
        const updatedAt = order.updated_at ? new Date(order.updated_at) : null;
        if (updatedAt && cutoff && updatedAt < cutoff) {
          reachedCutoff = true;
          break;
        }
        allOrders.push(order);
      }
      if (reachedCutoff) break;
    }

    // Báo cáo tiến độ sau mỗi trang
    if (onProgress) onProgress(allOrders.length, pageNumber);

    if (orders.length < 50) break;
    pageNumber++;

    // Log progress mỗi 10 pages
    if (pageNumber % 10 === 0) {
      log.info(TAG, `  ...page ${pageNumber}, ${allOrders.length} orders so far`);
    }

    await sleep(300);
  }

  log.info(TAG, `Fetched ${allOrders.length} orders (${pageNumber} pages)`);
  return allOrders;
}

module.exports = { getShops, getOrder, getOrders, getRecentOrders, parseWebhookPayload };
