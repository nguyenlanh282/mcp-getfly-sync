require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT) || 3000,

  pancakePOS: {
    apiKey: process.env.PANCAKE_POS_API_KEY,
    baseURL: process.env.PANCAKE_POS_BASE_URL || 'https://pos.pages.fm/api/v1',
    shopId: process.env.PANCAKE_SHOP_ID,
  },

  pancakeChat: {
    pageToken: process.env.PANCAKE_CHAT_PAGE_TOKEN,
    baseURL: process.env.PANCAKE_CHAT_BASE_URL || 'https://pages.fm/api/public_api/v1',
    pageId: process.env.PANCAKE_CHAT_PAGE_ID,
  },

  getfly: {
    apiKey: process.env.GETFLY_API_KEY,
    baseURL: process.env.GETFLY_BASE_URL,
  },

  webhookSecret: process.env.WEBHOOK_SECRET || '',

  admin: {
    user: process.env.ADMIN_USER || 'admin',
    pass: process.env.ADMIN_PASS || 'Admin@123',
  },
  sessionSecret: process.env.SESSION_SECRET || 'default-secret-change-me',

  chatPollInterval: parseInt(process.env.CHAT_POLL_INTERVAL) || 30000,
  orderSyncInterval: parseInt(process.env.ORDER_SYNC_INTERVAL) || 5 * 60 * 1000,
  orderSyncDays: process.env.ORDER_SYNC_DAYS !== undefined ? parseInt(process.env.ORDER_SYNC_DAYS) : 2,
};
