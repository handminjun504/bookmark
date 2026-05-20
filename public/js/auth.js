const Auth = (() => {
  let _token = null;
  let _user = null;
  let _lockTimer = null;
  let _lastActivity = Date.now();

  const API = '/api';

  async function request(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (_token) headers['Authorization'] = `Bearer ${_token}`;
    const res = await fetch(`${API}${path}`, { ...options, headers });
    if (res.status === 401) {
      logout();
      throw new Error('Session expired');
    }
    let data;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(res.ok ? text : `서버 오류 (${res.status}): ${text.substring(0, 100)}`);
    }
    if (!res.ok) throw new Error(data.detail || 'Request failed');
    return data;
  }

  async function login(username, password, rememberDevice) {
    const deviceName = `${navigator.platform} - ${navigator.userAgent.split('(')[1]?.split(')')[0] || 'Browser'}`;
    const data = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username,
        password,
        remember_device: rememberDevice,
        device_name: deviceName,
      }),
    });
    _token = data.token;
    _user = data.user;
    sessionStorage.setItem('token', _token);
    sessionStorage.setItem('user', JSON.stringify(_user));
    if (data.device_token) {
      localStorage.setItem('device_token', data.device_token);
    }
    startLockTimer();
    return data;
  }

  function _parseJwtExp(token) {
    try {
      return JSON.parse(atob(token.split('.')[1])).exp;
    } catch { return null; }
  }

  function _isTokenExpired(token) {
    const exp = _parseJwtExp(token);
    return exp ? Date.now() / 1000 > exp : true;
  }

  async function autoLogin() {
    const deviceToken = localStorage.getItem('device_token');
    if (!deviceToken) return null;
    try {
      const data = await request('/auth/auto-login', {
        method: 'POST',
        body: JSON.stringify({ device_token: deviceToken }),
      });
      _token = data.token;
      _user = data.user;
      sessionStorage.setItem('token', _token);
      sessionStorage.setItem('user', JSON.stringify(_user));
      startLockTimer();
      return data;
    } catch {
      // 네트워크 오류 시 device_token 유지 (의도적 삭제는 logout에서만)
      return null;
    }
  }

  function restoreSession() {
    const token = sessionStorage.getItem('token');
    const user = sessionStorage.getItem('user');
    if (token && user && !_isTokenExpired(token)) {
      _token = token;
      _user = JSON.parse(user);
      startLockTimer();
      return true;
    }
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('user');
    return false;
  }

  function logout(forgetDevice = true) {
    _token = null;
    _user = null;
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('user');
    if (forgetDevice) localStorage.removeItem('device_token');
    stopLockTimer();
    if (window.electronAPI?.clearPasswordUser) {
      window.electronAPI.clearPasswordUser();
    }
    location.reload();
  }

  function getUser() { return _user; }
  function getToken() { return _token; }
  function isAdmin() { return _user?.is_admin || false; }
  function isLoggedIn() { return !!_token; }

  function updateUser(updates) {
    _user = { ..._user, ...updates };
    sessionStorage.setItem('user', JSON.stringify(_user));
  }

  // ── Lock Screen ──

  function startLockTimer() {
    stopLockTimer();
    if (!_user?.lock_enabled) return;
    _lastActivity = Date.now();
    const timeout = (_user.lock_timeout || 300) * 1000;
    _lockTimer = setInterval(() => {
      if (Date.now() - _lastActivity > timeout) {
        showLockScreen();
      }
    }, 5000);
  }

  function stopLockTimer() {
    if (_lockTimer) clearInterval(_lockTimer);
    _lockTimer = null;
  }

  function resetActivity() {
    _lastActivity = Date.now();
  }

  function showLockScreen() {
    if (!_user?.has_pin) return;
    const el = document.getElementById('lock-screen');
    if (!el || !el.classList.contains('hidden')) return;
    el.classList.remove('hidden');
    const pinInput = document.getElementById('lock-pin-input');
    if (pinInput) { pinInput.value = ''; pinInput.focus(); }
  }

  async function tryUnlock(pin) {
    try {
      await request('/user/unlock', { method: 'POST', body: JSON.stringify({ pin }) });
      return true;
    } catch { return false; }
  }

  return {
    request,
    login,
    autoLogin,
    restoreSession,
    logout,
    getUser,
    getToken,
    isAdmin,
    isLoggedIn,
    updateUser,
    startLockTimer,
    stopLockTimer,
    resetActivity,
    showLockScreen,
    tryUnlock,
  };
})();

['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
  document.addEventListener(evt, () => Auth.resetActivity(), { passive: true });
});
