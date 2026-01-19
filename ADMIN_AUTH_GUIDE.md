# TimrX Admin Authentication System - Implementation Guide

## Current System Overview

**Current Setup:**
- Uses a simple API token (`X-Admin-Token` header)
- Token stored in `sessionStorage`
- No username/password login
- Token is your Render.com API key (hardcoded in backend)

**Issues:**
- ❌ Not scalable for multiple admins
- ❌ No password-based authentication
- ❌ Token exposed in backend code
- ❌ No session management
- ❌ No password reset functionality

---

## 🎯 Recommended: JWT-Based Authentication System

### Architecture Overview

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   Frontend  │ ──POST→ │   Backend    │ ──Verify→│  Database   │
│  (admin.html)│ ←─JWT─ │  (Flask API)  │         │  (SQLite/   │
│             │         │              │         │  PostgreSQL)│
└─────────────┘         └──────────────┘         └─────────────┘
```

---

## 📋 Implementation Steps

### Step 1: Backend Setup (Flask)

#### 1.1 Install Required Packages

```bash
pip install flask-jwt-extended bcrypt
```

#### 1.2 Create Admin User Model

Create `models.py` in your backend:

```python
from datetime import datetime
import bcrypt
from your_db import db  # Your database instance

class AdminUser(db.Model):
    __tablename__ = 'admin_users'

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime, nullable=True)

    def set_password(self, password):
        """Hash password using bcrypt"""
        self.password_hash = bcrypt.hashpw(
            password.encode('utf-8'),
            bcrypt.gensalt()
        ).decode('utf-8')

    def check_password(self, password):
        """Verify password against hash"""
        return bcrypt.checkpw(
            password.encode('utf-8'),
            self.password_hash.encode('utf-8')
        )

    def to_dict(self):
        return {
            'id': self.id,
            'username': self.username,
            'email': self.email,
            'is_active': self.is_active,
            'last_login': self.last_login.isoformat() if self.last_login else None
        }
```

#### 1.3 Update Flask App Configuration

Update your Flask app (e.g., `app.py` or `blogs_api.py`):

```python
from flask import Flask, request, jsonify
from flask_jwt_extended import (
    JWTManager, create_access_token, create_refresh_token,
    jwt_required, get_jwt_identity, get_jwt
)
from datetime import timedelta
import os

app = Flask(__name__)

# JWT Configuration
app.config['JWT_SECRET_KEY'] = os.environ.get('JWT_SECRET_KEY', 'your-secret-key-change-this')
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(hours=1)
app.config['JWT_REFRESH_TOKEN_EXPIRES'] = timedelta(days=30)
app.config['JWT_TOKEN_LOCATION'] = ['headers']
app.config['JWT_HEADER_NAME'] = 'Authorization'
app.config['JWT_HEADER_TYPE'] = 'Bearer'

jwt = JWTManager(app)

# Token blocklist for logout (use Redis in production)
BLOCKLIST = set()

@jwt.token_in_blocklist_loader
def check_if_token_revoked(jwt_header, jwt_payload):
    jti = jwt_payload['jti']
    return jti in BLOCKLIST
```

#### 1.4 Create Authentication Routes

Add these routes to your Flask app:

```python
# ========================================
# ADMIN AUTHENTICATION ROUTES
# ========================================

@app.route('/api/admin/login', methods=['POST'])
def admin_login():
    """Admin login endpoint"""
    try:
        data = request.get_json()
        username = data.get('username', '').strip()
        password = data.get('password', '')

        if not username or not password:
            return jsonify({'error': 'Username and password required'}), 400

        # Find admin user
        admin = AdminUser.query.filter_by(username=username).first()

        if not admin or not admin.check_password(password):
            return jsonify({'error': 'Invalid credentials'}), 401

        if not admin.is_active:
            return jsonify({'error': 'Account deactivated'}), 403

        # Update last login
        admin.last_login = datetime.utcnow()
        db.session.commit()

        # Create tokens
        access_token = create_access_token(identity=admin.id)
        refresh_token = create_refresh_token(identity=admin.id)

        return jsonify({
            'access_token': access_token,
            'refresh_token': refresh_token,
            'admin': admin.to_dict()
        }), 200

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/admin/refresh', methods=['POST'])
@jwt_required(refresh=True)
def admin_refresh():
    """Refresh access token"""
    try:
        admin_id = get_jwt_identity()
        access_token = create_access_token(identity=admin_id)
        return jsonify({'access_token': access_token}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/admin/logout', methods=['POST'])
@jwt_required()
def admin_logout():
    """Logout and revoke token"""
    try:
        jti = get_jwt()['jti']
        BLOCKLIST.add(jti)
        return jsonify({'message': 'Successfully logged out'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/admin/me', methods=['GET'])
@jwt_required()
def admin_me():
    """Get current admin user info"""
    try:
        admin_id = get_jwt_identity()
        admin = AdminUser.query.get(admin_id)

        if not admin or not admin.is_active:
            return jsonify({'error': 'Unauthorized'}), 401

        return jsonify(admin.to_dict()), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/admin/change-password', methods=['POST'])
@jwt_required()
def admin_change_password():
    """Change admin password"""
    try:
        admin_id = get_jwt_identity()
        admin = AdminUser.query.get(admin_id)

        if not admin:
            return jsonify({'error': 'Unauthorized'}), 401

        data = request.get_json()
        current_password = data.get('current_password', '')
        new_password = data.get('new_password', '')

        if not current_password or not new_password:
            return jsonify({'error': 'Current and new password required'}), 400

        if len(new_password) < 8:
            return jsonify({'error': 'Password must be at least 8 characters'}), 400

        if not admin.check_password(current_password):
            return jsonify({'error': 'Current password incorrect'}), 401

        admin.set_password(new_password)
        db.session.commit()

        return jsonify({'message': 'Password changed successfully'}), 200

    except Exception as e:
        return jsonify({'error': str(e)}), 500
```

#### 1.5 Update Protected Routes

Update all admin routes to use JWT:

```python
# Replace old @admin_required decorator or token check with:

@app.route('/api/admin/posts', methods=['GET'])
@jwt_required()
def admin_get_posts():
    admin_id = get_jwt_identity()
    admin = AdminUser.query.get(admin_id)

    if not admin or not admin.is_active:
        return jsonify({'error': 'Unauthorized'}), 401

    # Your existing code...
    pass

# Do the same for all admin routes:
# - /api/admin/publish/<slug>
# - /api/admin/unpublish/<slug>
# - /api/post/<slug> (DELETE, PATCH)
```

#### 1.6 Create Initial Admin User Script

Create `create_admin.py`:

```python
from app import app, db
from models import AdminUser

def create_initial_admin():
    with app.app_context():
        # Check if admin exists
        admin = AdminUser.query.filter_by(username='dima').first()

        if admin:
            print("❌ Admin user already exists")
            return

        # Create new admin
        admin = AdminUser(
            username='dima',
            email='dima.vasiliu@yahoo.com'
        )
        admin.set_password('YourSecurePassword123!')  # Change this!

        db.session.add(admin)
        db.session.commit()

        print("✅ Admin user created successfully!")
        print(f"   Username: {admin.username}")
        print(f"   Email: {admin.email}")
        print("   ⚠️  Remember to change the password after first login!")

if __name__ == '__main__':
    create_initial_admin()
```

Run it:
```bash
python create_admin.py
```

---

### Step 2: Frontend Update (admin.html)

Replace the authentication section in `admin.html`:

```javascript
// ========================================
// AUTHENTICATION SYSTEM
// ========================================

const API_BASE = 'https://timrx-blogs-api-1.onrender.com';
const API = API_BASE.replace(/\/$/, '') + '/api';

const AUTH_KEYS = {
  ACCESS_TOKEN: 'TX_ACCESS_TOKEN',
  REFRESH_TOKEN: 'TX_REFRESH_TOKEN',
  ADMIN_INFO: 'TX_ADMIN_INFO'
};

// Token Management
function getAccessToken() {
  return localStorage.getItem(AUTH_KEYS.ACCESS_TOKEN) || '';
}

function getRefreshToken() {
  return localStorage.getItem(AUTH_KEYS.REFRESH_TOKEN) || '';
}

function setTokens(accessToken, refreshToken) {
  localStorage.setItem(AUTH_KEYS.ACCESS_TOKEN, accessToken);
  localStorage.setItem(AUTH_KEYS.REFRESH_TOKEN, refreshToken);
}

function getAdminInfo() {
  const info = localStorage.getItem(AUTH_KEYS.ADMIN_INFO);
  return info ? JSON.parse(info) : null;
}

function setAdminInfo(info) {
  localStorage.setItem(AUTH_KEYS.ADMIN_INFO, JSON.stringify(info));
}

function clearAuth() {
  localStorage.removeItem(AUTH_KEYS.ACCESS_TOKEN);
  localStorage.removeItem(AUTH_KEYS.REFRESH_TOKEN);
  localStorage.removeItem(AUTH_KEYS.ADMIN_INFO);
}

// Headers with JWT
function headers() {
  const token = getAccessToken();
  return {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` })
  };
}

// Login Handler
$('#enter').onclick = async () => {
  const username = $('#username').value.trim();
  const password = $('#password').value;

  if (!username || !password) {
    $('#lmsg').textContent = 'Please enter username and password';
    return;
  }

  $('#lmsg').textContent = 'Logging in...';
  $('#enter').disabled = true;

  try {
    const response = await fetch(`${API}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Login failed');
    }

    // Store tokens and admin info
    setTokens(data.access_token, data.refresh_token);
    setAdminInfo(data.admin);

    // Hide login modal and load posts
    $('#login').classList.remove('show');
    $('#username').value = '';
    $('#password').value = '';
    $('#lmsg').textContent = '';

    await load();

  } catch (error) {
    $('#lmsg').textContent = error.message || 'Login failed';
  } finally {
    $('#enter').disabled = false;
  }
};

// Logout Handler
$('#logout').onclick = async () => {
  try {
    // Call logout endpoint to revoke token
    await fetch(`${API}/admin/logout`, {
      method: 'POST',
      headers: headers()
    });
  } catch (e) {
    console.error('Logout error:', e);
  } finally {
    clearAuth();
    location.reload();
  }
};

// Token Refresh
async function refreshAccessToken() {
  try {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;

    const response = await fetch(`${API}/admin/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${refreshToken}`
      }
    });

    if (!response.ok) return false;

    const data = await response.json();
    localStorage.setItem(AUTH_KEYS.ACCESS_TOKEN, data.access_token);
    return true;

  } catch (e) {
    return false;
  }
}

// Enhanced Fetch with Auto Token Refresh
async function fetchWithAuth(url, options = {}) {
  let response = await fetch(url, {
    ...options,
    headers: { ...headers(), ...options.headers }
  });

  // If 401, try to refresh token and retry
  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      response = await fetch(url, {
        ...options,
        headers: { ...headers(), ...options.headers }
      });
    } else {
      clearAuth();
      $('#login').classList.add('show');
      throw new Error('Session expired');
    }
  }

  return response;
}

// Check Authentication
async function ensureAuth() {
  const token = getAccessToken();

  if (!token) {
    $('#login').classList.add('show');
    return false;
  }

  try {
    const response = await fetchWithAuth(`${API}/admin/me`);

    if (!response.ok) {
      throw new Error('Unauthorized');
    }

    const adminInfo = await response.json();
    setAdminInfo(adminInfo);

    // Display admin info in UI
    const adminName = adminInfo.username || 'Admin';
    document.querySelector('.nav-links').insertAdjacentHTML('afterbegin',
      `<span class="admin-badge">👤 ${adminName}</span>`
    );

    return true;

  } catch (e) {
    clearAuth();
    $('#login').classList.add('show');
    return false;
  }
}

// Initialize
(async function() {
  if (await ensureAuth()) {
    await load();
  }
})();
```

Update the login modal HTML in admin.html:

```html
<!-- Login Modal -->
<div class="modal" id="login">
  <div class="panel" style="width:min(420px,96vw)">
    <h3>Admin Login</h3>
    <label>Username
      <input id="username" type="text" placeholder="Your username" autocomplete="username"/>
    </label>
    <label>Password
      <input id="password" type="password" placeholder="Your password" autocomplete="current-password"/>
    </label>
    <div class="row" style="margin-top:10px">
      <span id="lmsg" class="muted"></span>
      <button id="enter" class="btn primary" style="margin-left:auto">Log In</button>
    </div>
  </div>
</div>
```

---

## 🔐 Security Best Practices

### 1. Environment Variables

Never hardcode secrets. Use `.env` file:

```bash
# .env
JWT_SECRET_KEY=your-super-secret-random-string-here-use-secrets.token_hex(32)
DATABASE_URL=postgresql://user:pass@host/dbname
FLASK_ENV=production
```

Load in Flask:
```python
from dotenv import load_dotenv
load_dotenv()
```

### 2. HTTPS Only

In production, enforce HTTPS:
```python
@app.before_request
def before_request():
    if not request.is_secure and app.env == 'production':
        return redirect(request.url.replace('http://', 'https://'))
```

### 3. Rate Limiting

Install: `pip install flask-limiter`

```python
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(
    app,
    key_func=get_remote_address,
    default_limits=["200 per day", "50 per hour"]
)

@app.route('/api/admin/login', methods=['POST'])
@limiter.limit("5 per minute")  # Max 5 login attempts per minute
def admin_login():
    # ...
```

### 4. Password Requirements

```python
import re

def validate_password(password):
    """
    Password must be:
    - At least 8 characters
    - Contains uppercase and lowercase
    - Contains numbers
    - Contains special characters
    """
    if len(password) < 8:
        return False, "Password must be at least 8 characters"

    if not re.search(r'[A-Z]', password):
        return False, "Password must contain uppercase letter"

    if not re.search(r'[a-z]', password):
        return False, "Password must contain lowercase letter"

    if not re.search(r'\d', password):
        return False, "Password must contain number"

    if not re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
        return False, "Password must contain special character"

    return True, "Valid"
```

---

## 🚀 Deployment Checklist

- [ ] Generate strong JWT secret: `python -c "import secrets; print(secrets.token_hex(32))"`
- [ ] Set environment variables on Render.com
- [ ] Create initial admin user
- [ ] Test login/logout flow
- [ ] Test token refresh
- [ ] Enable HTTPS
- [ ] Add rate limiting
- [ ] Set up monitoring/logging
- [ ] Create backup admin account
- [ ] Document password reset procedure

---

## 📱 Optional: Two-Factor Authentication (2FA)

For extra security, add 2FA using `pyotp`:

```bash
pip install pyotp qrcode
```

Add to AdminUser model:
```python
class AdminUser(db.Model):
    # ... existing fields ...
    totp_secret = db.Column(db.String(32), nullable=True)
    two_factor_enabled = db.Column(db.Boolean, default=False)
```

Implementation in ADMIN_AUTH_2FA.md (create if needed).

---

## 🎯 Quick Start for Your Use Case

**For immediate use:**

1. Run the create_admin.py script
2. Use credentials:
   - Username: `dima`
   - Password: (set in script)
3. Login at admin.html
4. Change password immediately from settings

**Next steps:**
- Add password reset via email
- Add admin user management page
- Set up audit logs for admin actions
- Implement session timeout warnings

---

## 📞 Need Help?

Common issues:
- **"Invalid credentials"** → Check username/password are correct
- **"Token expired"** → Refresh token should auto-renew, check refresh endpoint
- **"CORS error"** → Add frontend domain to CORS allowed origins
- **"Database error"** → Run migrations: `flask db upgrade`

