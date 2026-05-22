const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const webhookRouter = require('./routes/webhook');
const apiRouter = require('./routes/api');
const authRouter = require('./routes/auth');
const chatPoller = require('./jobs/chatPoller');
const orderSync = require('./jobs/orderSync');
const staffMapper = require('./utils/staffMapper');
const log = require('./utils/logger');

const TAG = 'Server';
const app = express();

// Trust reverse proxy (Cloudflare, Nginx, Traefik)
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple file-based session store (no extra dependency needed)
// Replaces MemoryStore to avoid memory leak in production
function createFileSessionStore(SessionStore) {
  const SESSION_DIR = path.join(__dirname, '../data/sessions');
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

  class FileStore extends SessionStore {
    get(sid, cb) {
      try {
        const file = path.join(SESSION_DIR, sid + '.json');
        if (!fs.existsSync(file)) return cb(null, null);
        const sess = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (sess.cookie && sess.cookie.expires && new Date(sess.cookie.expires) < new Date()) {
          this.destroy(sid, () => {});
          return cb(null, null);
        }
        cb(null, sess);
      } catch { cb(null, null); }
    }
    set(sid, sess, cb) {
      try {
        const file = path.join(SESSION_DIR, sid + '.json');
        fs.writeFileSync(file, JSON.stringify(sess));
        cb && cb(null);
      } catch (e) { cb && cb(e); }
    }
    destroy(sid, cb) {
      try {
        const file = path.join(SESSION_DIR, sid + '.json');
        if (fs.existsSync(file)) fs.unlinkSync(file);
        cb && cb(null);
      } catch { cb && cb(null); }
    }
  }
  return new FileStore();
}

// Session middleware
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: process.env.NODE_ENV === 'production' ? createFileSessionStore(session.Store) : undefined,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // true in production (behind proxy)
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Auth routes (login/logout) - không cần auth
app.use('/auth', authRouter);

// Webhook routes - xác thực bằng webhook secret riêng, không cần session
app.use('/webhook', webhookRouter);

// Health check - public
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Auth middleware - chặn tất cả các route bên dưới
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  // Nếu request HTML → redirect tới login
  if (req.accepts('html')) {
    return res.redirect('/auth/login');
  }
  // Nếu request API → trả 401
  return res.status(401).json({ error: 'Unauthorized' });
}

app.use(requireAuth);

// Static files (dashboard) - sau auth middleware, no cache for dev
app.use(express.static(path.join(__dirname, '../public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  },
}));

// API routes (dashboard)
app.use('/api', apiRouter);

// Status endpoint
app.get('/status', async (req, res) => {
  try {
    const users = await staffMapper.loadGetflyUsers();
    res.json({
      status: 'running',
      getflyUsers: users.length,
      config: {
        pancakeShopId: config.pancakePOS.shopId || 'NOT SET',
        pancakeChatPageId: config.pancakeChat.pageId || 'NOT SET',
        getflyBaseURL: config.getfly.baseURL || 'NOT SET',
        pollInterval: config.chatPollInterval,
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

async function start() {
  // Validate required config
  const missing = [];
  if (!config.pancakePOS.apiKey) missing.push('PANCAKE_POS_API_KEY');
  if (!config.pancakePOS.shopId) missing.push('PANCAKE_SHOP_ID');
  if (!config.pancakeChat.pageId) missing.push('PANCAKE_CHAT_PAGE_ID');
  if (!config.getfly.baseURL) missing.push('GETFLY_BASE_URL');
  if (!config.getfly.apiKey) missing.push('GETFLY_API_KEY');

  if (missing.length > 0) {
    log.warn(TAG, `Missing config: ${missing.join(', ')}. Some features may not work.`);
  }

  app.listen(config.port, () => {
    log.info(TAG, `Server running on port ${config.port}`);
    log.info(TAG, `Dashboard: http://localhost:${config.port}`);
    log.info(TAG, `Webhook URL: http://localhost:${config.port}/webhook/pancake-pos`);
    log.info(TAG, `Auto-start: ${process.env.SYNC_AUTO_START === 'true' ? 'ON' : 'OFF (manual from dashboard)'}`);
  });

  // Auto-start chỉ khi SYNC_AUTO_START=true được set rõ ràng
  if (process.env.SYNC_AUTO_START === 'true') {
    log.info(TAG, 'SYNC_AUTO_START=true — starting scheduler and poller automatically...');
    // Pre-load Getfly users for staff mapping
    await staffMapper.loadGetflyUsers().catch((err) => {
      log.warn(TAG, 'Could not pre-load Getfly users:', { error: err.message });
    });
    chatPoller.start(config.chatPollInterval);
    orderSync.start(config.orderSyncInterval, config.orderSyncDays);
  } else {
    log.info(TAG, 'Ready. Scheduler and Poller are OFF — enable from the dashboard.');
  }
}

process.on('SIGTERM', () => {
  log.info(TAG, 'Shutting down...');
  chatPoller.stop();
  orderSync.stop();
  process.exit(0);
});

start();
