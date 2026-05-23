const getfly = require('../services/getfly');
const log = require('../utils/logger');

const TAG = 'StaffMapper';

let getflyUsers = [];
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function loadGetflyUsers() {
  const now = Date.now();
  if (getflyUsers.length > 0 && now - lastFetchTime < CACHE_TTL) {
    return getflyUsers;
  }

  try {
    const users = await getfly.getUsers();
    getflyUsers = Array.isArray(users) ? users : [];
    lastFetchTime = now;
    log.info(TAG, `Loaded ${getflyUsers.length} Getfly users`);
  } catch (err) {
    log.error(TAG, 'Failed to load Getfly users:', { error: err.message });
  }

  return getflyUsers;
}

function normalizeVN(str) {
  if (!str) return '';
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').trim();
}

async function findGetflyUser(pancakeStaffName, pancakeStaffEmail) {
  const users = await loadGetflyUsers();

  // Người dùng Getfly có: user_id, contact_name, user_name (email), email
  // Nhân viên Pancake Chat có: name, email

  // 1. Khớp chính xác theo email
  if (pancakeStaffEmail) {
    const emailLower = pancakeStaffEmail.toLowerCase();
    const match = users.find(
      (u) => (u.email && u.email.toLowerCase() === emailLower) ||
             (u.user_name && u.user_name.toLowerCase() === emailLower)
    );
    if (match) {
      log.debug(TAG, `Matched by email: "${pancakeStaffEmail}" -> ${match.contact_name} (user_id: ${match.user_id})`);
      return match;
    }
  }

  log.warn(TAG, `No match found for email: ${pancakeStaffEmail} (Name: ${pancakeStaffName})`);
  return null;
}

function clearCache() {
  getflyUsers = [];
  lastFetchTime = 0;
}

module.exports = { findGetflyUser, loadGetflyUsers, clearCache };
