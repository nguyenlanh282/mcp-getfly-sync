const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const log = require('../utils/logger');

const router = express.Router();
const TAG = 'Auth';

// Login page
router.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.send(loginHTML());
});

// Login API
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  const usernameMatch = username === config.admin.user;
  // Support both plain-text (legacy) and bcrypt hashed passwords
  const isHashed = config.admin.pass.startsWith('$2');
  const passwordMatch = isHashed
    ? bcrypt.compareSync(password, config.admin.pass)
    : password === config.admin.pass;

  if (usernameMatch && passwordMatch) {
    // Auto-upgrade plain-text password to bcrypt on first successful login
    if (!isHashed) {
      const hashed = bcrypt.hashSync(password, 10);
      config.admin.pass = hashed;
      try {
        const { updateEnvFile } = require('./api');
        // updateEnvFile not exported — will be saved on next password change
      } catch {}
    }
    req.session.authenticated = true;
    req.session.username = username;
    log.info(TAG, `Login success: ${username} from ${req.ip}`);
    return res.json({ success: true });
  }

  log.warn(TAG, `Login failed: ${username} from ${req.ip}`);
  return res.status(401).json({ error: 'Sai username hoặc password' });
});

// Logout
router.post('/logout', (req, res) => {
  const user = req.session.username;
  req.session.destroy(() => {
    log.info(TAG, `Logout: ${user}`);
    res.json({ success: true });
  });
});

function loginHTML() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - Pancake Getfly Sync</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1E293B 0%, #334155 50%, #1E293B 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-card {
      background: #fff;
      border-radius: 16px;
      padding: 40px;
      width: 400px;
      max-width: 90vw;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .login-header {
      text-align: center;
      margin-bottom: 32px;
    }
    .login-header .logo {
      font-size: 40px;
      margin-bottom: 8px;
    }
    .login-header h1 {
      font-size: 22px;
      color: #1E293B;
      font-weight: 700;
    }
    .login-header p {
      font-size: 13px;
      color: #64748B;
      margin-top: 4px;
    }
    .input-group {
      margin-bottom: 20px;
    }
    .input-group label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #475569;
      margin-bottom: 6px;
    }
    .input-group input {
      width: 100%;
      padding: 12px 14px;
      border: 1.5px solid #E2E8F0;
      border-radius: 10px;
      font-size: 15px;
      color: #1E293B;
      transition: all 0.2s;
      outline: none;
    }
    .input-group input:focus {
      border-color: #4F46E5;
      box-shadow: 0 0 0 3px rgba(79,70,229,0.1);
    }
    .btn-login {
      width: 100%;
      padding: 13px;
      background: #4F46E5;
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-login:hover { background: #3730A3; }
    .btn-login:disabled { background: #94A3B8; cursor: not-allowed; }
    .error-msg {
      background: #FEF2F2;
      color: #DC2626;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 16px;
      display: none;
    }
    .error-msg.show { display: block; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="login-header">
      <div class="logo">&#x1F95E;</div>
      <h1>Sync Panel</h1>
      <p>Pancake POS &middot; Chat &middot; Getfly CRM</p>
    </div>
    <div class="error-msg" id="error-msg"></div>
    <form id="login-form">
      <div class="input-group">
        <label>Username</label>
        <input type="text" id="username" name="username" autofocus required placeholder="Nhập username">
      </div>
      <div class="input-group">
        <label>Password</label>
        <input type="password" id="password" name="password" required placeholder="Nhập password">
      </div>
      <button type="submit" class="btn-login" id="btn-login">Đăng nhập</button>
    </form>
  </div>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-login');
      const err = document.getElementById('error-msg');
      btn.disabled = true;
      btn.textContent = 'Đang đăng nhập...';
      err.classList.remove('show');

      try {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
          }),
        });
        const data = await res.json();
        if (data.success) {
          window.location.href = '/';
        } else {
          err.textContent = data.error || 'Login failed';
          err.classList.add('show');
        }
      } catch (ex) {
        err.textContent = 'Connection error';
        err.classList.add('show');
      }
      btn.disabled = false;
      btn.textContent = 'Đăng nhập';
    });
  </script>
</body>
</html>`;
}

module.exports = router;
