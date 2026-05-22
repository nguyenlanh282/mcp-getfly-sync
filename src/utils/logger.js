const fs = require('fs');
const path = require('path');

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.INFO;

// File-based persistence
const DATA_DIR = path.join(__dirname, '../../data');
const LOG_FILE = path.join(DATA_DIR, 'logs.json');
const MAX_LOG_BUFFER = 1000;
const SAVE_INTERVAL = 10000; // Save every 10 seconds

// In-memory log buffer
let logBuffer = [];
let dirty = false;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load logs from file on startup
function loadLogs() {
  try {
    ensureDir();
    if (fs.existsSync(LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
      logBuffer = Array.isArray(data) ? data.slice(0, MAX_LOG_BUFFER) : [];
    }
  } catch {
    logBuffer = [];
  }
}

// Save logs to file
function saveLogs() {
  if (!dirty) return;
  try {
    ensureDir();
    fs.writeFileSync(LOG_FILE, JSON.stringify(logBuffer.slice(0, MAX_LOG_BUFFER)), 'utf-8');
    dirty = false;
  } catch (err) {
    console.error('[Logger] Failed to save logs:', err.message);
  }
}

function formatTime() {
  return new Date().toISOString();
}

function log(level, tag, message, data) {
  if (LOG_LEVELS[level] > currentLevel) return;
  const prefix = `[${formatTime()}] [${level}] [${tag}]`;
  const entry = {
    time: formatTime(),
    level,
    tag,
    message: data !== undefined ? `${message} ${JSON.stringify(data)}` : message,
  };

  // Push to buffer
  logBuffer.unshift(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.length = MAX_LOG_BUFFER;
  dirty = true;

  // Console output
  if (data !== undefined) {
    console.log(prefix, message, JSON.stringify(data, null, 2));
  } else {
    console.log(prefix, message);
  }
}

function getRecentLogs(limit = 100, filter = null) {
  let logs = logBuffer;
  if (filter) {
    const f = filter.toLowerCase();
    logs = logs.filter(
      (l) => l.tag.toLowerCase().includes(f) || l.message.toLowerCase().includes(f) || l.level.toLowerCase().includes(f)
    );
  }
  return logs.slice(0, limit);
}

// Init: load from file + periodic save
loadLogs();
const saveTimer = setInterval(saveLogs, SAVE_INTERVAL);

// Save on process exit
process.on('exit', saveLogs);
process.on('SIGTERM', () => { saveLogs(); process.exit(0); });
process.on('SIGINT', () => { saveLogs(); process.exit(0); });

module.exports = {
  info: (tag, msg, data) => log('INFO', tag, msg, data),
  warn: (tag, msg, data) => log('WARN', tag, msg, data),
  error: (tag, msg, data) => log('ERROR', tag, msg, data),
  debug: (tag, msg, data) => log('DEBUG', tag, msg, data),
  getRecentLogs,
  saveLogs, // Export for manual save
};
