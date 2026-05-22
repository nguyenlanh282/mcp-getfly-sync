const axios = require('axios');
const config = require('../config');
const log = require('../utils/logger');

const TAG = 'PancakeChat';

const client = axios.create({
  baseURL: config.pancakeChat.baseURL,
  timeout: 30000,
});

// Retry helper with exponential backoff
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

function getTimeRange(daysBack = 1) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - daysBack * 86400;
  return { since, until: now };
}

async function getConversations(params = {}) {
  const pageId = config.pancakeChat.pageId;
  const { since, until } = getTimeRange(1);
  const { data } = await client.get(`/pages/${pageId}/conversations`, {
    params: {
      access_token: config.pancakeChat.pageToken,
      since,
      until,
      page_number: 1,
      limit: 50,
      ...params,
    },
  });
  return data;
}

function extractAssignment(conversation) {
  const assignUsers = conversation.current_assign_users || [];
  const assignee = assignUsers[0] || null;

  return {
    id: conversation.id,
    customerName: conversation.from?.name,
    customerId: conversation.customer_id,
    customerPhone: extractPhone(conversation),
    assigneeId: assignee?.id || null,
    assigneeName: assignee?.name || null,
    assigneeEmail: assignee?.email || null,
  };
}

function extractPhone(conversation) {
  const phones = conversation.recent_phone_numbers || [];
  if (phones.length > 0) {
    const entry = phones[0];
    if (typeof entry === 'string') return entry;
    if (entry && entry.phone_number) return entry.phone_number;
    if (entry && entry.captured) return entry.captured;
  }
  return null;
}

async function getConversationById(conversationId) {
  const pageId = config.pancakeChat.pageId;
  const { since, until } = getTimeRange(7);
  let pageNumber = 1;
  const maxPages = 20;

  while (pageNumber <= maxPages) {
    const { data } = await client.get(`/pages/${pageId}/conversations`, {
      params: {
        access_token: config.pancakeChat.pageToken,
        since,
        until,
        page_number: pageNumber,
        limit: 50,
      },
    });

    const result = data || {};
    const conversations = result.conversations || [];
    if (conversations.length === 0) break;

    const found = conversations.find((c) => c.id === conversationId);
    if (found) {
      return extractAssignment(found);
    }

    if (conversations.length < 50) break;
    pageNumber++;
  }

  log.warn(TAG, `Conversation ${conversationId} not found`);
  return null;
}

async function getMultipleConversations(conversationIds) {
  const pageId = config.pancakeChat.pageId;
  const { since, until } = getTimeRange(28);
  const results = new Map();
  const idsSet = new Set(conversationIds);
  let pageNumber = 1;
  const maxPages = 30;

  while (pageNumber <= maxPages && idsSet.size > results.size) {
    const { data } = await client.get(`/pages/${pageId}/conversations`, {
      params: {
        access_token: config.pancakeChat.pageToken,
        since,
        until,
        page_number: pageNumber,
        limit: 50,
      },
    });

    const conversations = (data || {}).conversations || [];
    if (conversations.length === 0) break;

    for (const c of conversations) {
      if (idsSet.has(c.id)) {
        results.set(c.id, extractAssignment(c));
      }
    }

    if (conversations.length < 50) break;
    pageNumber++;
  }

  return results;
}

/**
 * Fetch conversations for a single time chunk.
 * Returns number of conversations added to results Map.
 */
async function fetchConversationChunk(pageId, since, until, results, maxPages = 100) {
  let pageNumber = 1;
  let added = 0;

  while (pageNumber <= maxPages) {
    const { data } = await withRetry(() =>
      client.get(`/pages/${pageId}/conversations`, {
        params: {
          access_token: config.pancakeChat.pageToken,
          since,
          until,
          page_number: pageNumber,
          limit: 50,
        },
      })
    );

    const conversations = (data || {}).conversations || [];
    if (conversations.length === 0) break;

    for (const c of conversations) {
      if (!results.has(c.id)) {
        results.set(c.id, extractAssignment(c));
        added++;
      }
    }

    if (conversations.length < 50) break;
    pageNumber++;

    if (pageNumber % 10 === 0) {
      log.info(TAG, `  ...page ${pageNumber}, ${results.size} conversations so far`);
    }

    await sleep(300);
  }

  return added;
}

/**
 * Fetch ALL conversations from last N days.
 * Returns Map<conversationId, assignment>
 *
 * Pancake Chat API limits date range to < 1 month.
 * When syncAll (daysBack=0), we split into 30-day chunks going back 12 months.
 */
async function getAllRecentConversations(daysBack = 2) {
  const pageId = config.pancakeChat.pageId;
  const syncAll = daysBack === 0;
  const results = new Map();

  if (syncAll) {
    // API limit: date range < 1 month → split into 30-day chunks
    const CHUNK_DAYS = 28; // safe margin under 1 month
    const TOTAL_MONTHS = 12;
    log.info(TAG, `Fetching ALL conversations (${TOTAL_MONTHS} monthly chunks)...`);

    for (let i = 0; i < TOTAL_MONTHS; i++) {
      const chunkEnd = Math.floor(Date.now() / 1000) - i * CHUNK_DAYS * 86400;
      const chunkStart = chunkEnd - CHUNK_DAYS * 86400;
      const monthLabel = i === 0 ? 'current month' : `${i} month(s) ago`;

      const added = await fetchConversationChunk(pageId, chunkStart, chunkEnd, results, 100);
      log.info(TAG, `  Chunk "${monthLabel}": +${added} conversations (total: ${results.size})`);

      // If a chunk returns 0 new conversations, older chunks likely empty too
      if (added === 0 && i > 0) {
        log.info(TAG, `  No more conversations found, stopping at chunk ${i + 1}`);
        break;
      }
    }
  } else {
    // Normal mode: single range (guaranteed < 1 month for daysBack <= 28)
    const effectiveDays = Math.min(daysBack, 28);
    if (effectiveDays !== daysBack) {
      log.warn(TAG, `daysBack ${daysBack} exceeds API limit, clamped to ${effectiveDays}`);
    }
    const { since, until } = getTimeRange(effectiveDays);
    log.info(TAG, `Fetching all conversations (last ${effectiveDays} days)...`);
    await fetchConversationChunk(pageId, since, until, results, 100);
  }

  log.info(TAG, `Fetched ${results.size} total conversations`);
  return results;
}

module.exports = {
  getConversations,
  getConversationById,
  getMultipleConversations,
  getAllRecentConversations,
  extractAssignment,
};
