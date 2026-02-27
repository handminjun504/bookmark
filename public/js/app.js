(() => {
  let categories = [];
  let bookmarks = [];
  let sharedBookmarks = [];
  let activeCategory = 'all';
  let healthCache = {};
  let dragSrcId = null;
  let activeTab = 'bookmarks';
  let browserCurrentUrl = '';
  let dynTabs = [];
  let dynTabIdCounter = 0;
  let activeDynTabId = null;

  // ═══════ Init ═══════

  async function init() {
    const authMatch = location.hash.match(/__auth=([^&]+)/);
    if (authMatch) {
      try {
        const data = JSON.parse(decodeURIComponent(escape(atob(authMatch[1]))));
        if (data.token && data.user) {
          sessionStorage.setItem('token', data.token);
          sessionStorage.setItem('user', JSON.stringify(data.user));
        }
      } catch {}
    }

    if (Auth.restoreSession()) {
      showDashboard();
      return;
    }
    const autoResult = await Auth.autoLogin();
    if (autoResult) {
      showDashboard();
    } else {
      showLogin();
    }
  }

  // ═══════ Tab Navigation ═══════

  function switchTab(tab) {
    activeTab = tab;
    activeDynTabId = null;
    if (typeof applyZoom === 'function') applyZoom();

    document.querySelectorAll('.main-tab:not(.tab-add-btn)').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    document.querySelectorAll('.dyn-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => {
      c.classList.toggle('active', c.id === `tab-${tab}`);
    });

    const framesContainer = document.getElementById('dynamic-tab-frames');
    framesContainer.classList.remove('active');
    framesContainer.querySelectorAll('iframe, webview').forEach(f => f.classList.remove('active'));

    const addBmBtn = document.getElementById('btn-add-bookmark');
    const searchBox = document.getElementById('search-box-wrap');

    if (tab === 'bookmarks') {
      addBmBtn.style.display = '';
      searchBox.style.display = '';
    } else {
      addBmBtn.style.display = 'none';
      searchBox.style.display = 'none';
    }

    if (tab === 'clients') loadClientsTab();
    if (tab === 'calendar') Calendar.load();
    if (tab === 'memos') Memos.load();
  }

  function switchToDynTab(id) {
    activeDynTabId = id;
    activeTab = '__dyn__';
    document.body.style.zoom = 1;

    document.querySelectorAll('.main-tab:not(.tab-add-btn)').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.dyn-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.dynId === String(id));
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    const addBmBtn = document.getElementById('btn-add-bookmark');
    const searchBox = document.getElementById('search-box-wrap');
    addBmBtn.style.display = 'none';
    searchBox.style.display = 'none';

    const framesContainer = document.getElementById('dynamic-tab-frames');
    framesContainer.classList.add('active');
    const sel = isElectron ? 'webview' : 'iframe';
    framesContainer.querySelectorAll(sel).forEach(f => {
      f.classList.toggle('active', f.dataset.dynId === String(id));
    });

    const tab = dynTabs.find(t => t.id === id);
    if (tab) {
      tab.lastActive = Date.now();
      const urlBar = framesContainer.querySelector('#dtf-url-input');
      if (urlBar) urlBar.value = tab.url;

      const frame = framesContainer.querySelector(`${sel}[data-dyn-id="${id}"]`);
      if (frame && frame._crashed) {
        frame._crashed = false;
        frame.src = tab.url;
        const tabEl = document.querySelector(`.dyn-tab[data-dyn-id="${id}"]`);
        if (tabEl) tabEl.style.opacity = '';
      } else if (tab.hibernated) {
        if (frame && frame.tagName === 'WEBVIEW') {
          frame.src = tab.url;
          tab.hibernated = false;
          const tabEl = document.querySelector(`.dyn-tab[data-dyn-id="${id}"]`);
          if (tabEl) tabEl.classList.remove('hibernated');
        }
      }

      const noteKey = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
      const noteBtn = document.getElementById('dtf-note-btn');
      if (noteBtn) noteBtn.classList.toggle('has-note', !!urlNotes[noteKey]);
    }

    const activeFrame = framesContainer.querySelector(`${sel}.active`);
    updateZoomLabel(activeFrame);
  }

  function updateTabDivider() {
    const divider = document.getElementById('tab-divider');
    if (divider) divider.classList.toggle('visible', dynTabs.length > 0);
  }

  let containers = [];
  let splitMode = null;
  let hibernateTimerId = null;
  const urlNotes = JSON.parse(localStorage.getItem('lf_url_notes') || '{}');

  function createDynTab(url, title, containerId) {
    const id = ++dynTabIdCounter;
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch {}
    const tab = { id, url, title: title || hostname || url, containerId: containerId || null, lastActive: Date.now(), hibernated: false };
    dynTabs.push(tab);

    const container = document.getElementById('dynamic-tabs');
    const el = document.createElement('button');
    el.className = 'dyn-tab';
    el.dataset.dynId = id;

    const favicon = document.createElement('img');
    favicon.className = 'dyn-tab-favicon';
    favicon.src = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
    favicon.onerror = () => { favicon.style.display = 'none'; };

    const titleSpan = document.createElement('span');
    titleSpan.className = 'dyn-tab-title';
    titleSpan.textContent = tab.title;

    const detachBtn = document.createElement('span');
    detachBtn.className = 'dyn-tab-detach';
    detachBtn.innerHTML = '<i class="ri-external-link-line"></i>';
    detachBtn.title = '새 창으로 분리';
    detachBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sel = isElectron ? 'webview' : 'iframe';
      const frame = document.querySelector(`#dynamic-tab-frames ${sel}[data-dyn-id="${id}"]`);
      const currentUrl = frame ? (frame.src || frame.getURL?.() || url) : url;
      if (isElectron) {
        if (window.electronAPI?.flushCookies) {
          await window.electronAPI.flushCookies();
        }
        const authPayload = btoa(unescape(encodeURIComponent(
          JSON.stringify({ token: Auth.getToken(), user: Auth.getUser() })
        )));
        window.open(currentUrl + '#__detach&__auth=' + authPayload, '_blank');
      } else {
        window.open(currentUrl, '_blank');
      }
      removeDynTabUI(id);
    });

    const closeBtn = document.createElement('span');
    closeBtn.className = 'dyn-tab-close';
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDynTab(id);
    });

    const loadingDot = document.createElement('span');
    loadingDot.className = 'dyn-tab-loading';

    if (containerId) {
      const ct = containers.find(c => c.id === containerId);
      if (ct) {
        el.style.borderBottom = `3px solid ${ct.color}`;
        el.title = `[${ct.name}]`;
      }
    }
    el.appendChild(loadingDot);
    el.appendChild(favicon);
    el.appendChild(titleSpan);
    el.appendChild(detachBtn);
    el.appendChild(closeBtn);
    el.addEventListener('click', () => switchToDynTab(id));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); closeDynTab(id); }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabContextMenu(id, e.clientX, e.clientY);
    });
    el.draggable = true;
    let dynDragReordered = false;
    el.addEventListener('dragstart', (e) => {
      dynDragReordered = false;
      e.dataTransfer.setData('text/plain', String(id));
      el.classList.add('dyn-tab-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', async (e) => {
      el.classList.remove('dyn-tab-dragging');
      container.querySelectorAll('.dyn-tab-drop-target').forEach(t => t.classList.remove('dyn-tab-drop-target'));
      if (dynDragReordered) return;
      if (e.clientX === 0 && e.clientY === 0) return;
      const tabBar = document.getElementById('main-tab-bar');
      if (!tabBar) return;
      const rect = tabBar.getBoundingClientRect();
      const outside = e.clientY > rect.bottom + 40 || e.clientY < rect.top - 40;
      if (!outside) return;
      const sel = isElectron ? 'webview' : 'iframe';
      const frame = document.querySelector(`#dynamic-tab-frames ${sel}[data-dyn-id="${id}"]`);
      const currentUrl = frame ? (frame.src || frame.getURL?.() || url) : url;
      if (isElectron) {
        if (window.electronAPI?.flushCookies) await window.electronAPI.flushCookies();
        const authPayload = btoa(unescape(encodeURIComponent(
          JSON.stringify({ token: Auth.getToken(), user: Auth.getUser() })
        )));
        window.open(currentUrl + '#__detach&__auth=' + authPayload, '_blank');
      } else {
        window.open(currentUrl, '_blank');
      }
      removeDynTabUI(id);
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('dyn-tab-drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dyn-tab-drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dyn-tab-drop-target');
      const srcId = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const destId = id;
      if (srcId === destId) return;
      dynDragReordered = true;
      const srcIdx = dynTabs.findIndex(t => t.id === srcId);
      const destIdx = dynTabs.findIndex(t => t.id === destId);
      if (srcIdx < 0 || destIdx < 0) return;
      const [moved] = dynTabs.splice(srcIdx, 1);
      dynTabs.splice(destIdx, 0, moved);
      const srcEl = container.querySelector(`.dyn-tab[data-dyn-id="${srcId}"]`);
      const destEl = container.querySelector(`.dyn-tab[data-dyn-id="${destId}"]`);
      if (srcEl && destEl) {
        if (srcIdx < destIdx) destEl.after(srcEl);
        else container.insertBefore(srcEl, destEl);
      }
    });
    container.appendChild(el);
    updateTabDivider();

    const framesContainer = document.getElementById('dynamic-tab-frames');

    if (!framesContainer.querySelector('.dtf-toolbar')) {
      framesContainer.innerHTML = `
        <div class="dtf-toolbar">
          <button class="dtf-btn" id="dtf-back" title="뒤로"><i class="ri-arrow-left-line"></i></button>
          <button class="dtf-btn" id="dtf-forward" title="앞으로"><i class="ri-arrow-right-line"></i></button>
          <button class="dtf-btn" id="dtf-refresh" title="새로고침"><i class="ri-refresh-line"></i></button>
          <input class="dtf-url-bar" id="dtf-url-input" type="text" placeholder="URL 입력 또는 검색어" />
          <div class="dtf-zoom-ctrl">
            <button class="dtf-btn dtf-zoom-btn" id="dtf-zoom-out" title="축소 (Ctrl+-)"><i class="ri-subtract-line"></i></button>
            <span class="dtf-zoom-label" id="dtf-zoom-label">100%</span>
            <button class="dtf-btn dtf-zoom-btn" id="dtf-zoom-in" title="확대 (Ctrl++)"><i class="ri-add-line"></i></button>
            <button class="dtf-btn dtf-zoom-btn dtf-zoom-reset" id="dtf-zoom-reset" title="원래 크기 (Ctrl+0)">초기화</button>
          </div>
          <button class="dtf-btn" id="dtf-note-btn" title="사이트 메모"><i class="ri-sticky-note-line"></i></button>
          <button class="dtf-btn" id="dtf-split-btn" title="화면 분할 (Ctrl+\\)"><i class="ri-layout-column-line"></i></button>
          <button class="dtf-btn" id="dtf-pip-btn" title="PiP 미니 창"><i class="ri-picture-in-picture-exit-line"></i></button>
          <button class="dtf-btn" id="dtf-ss-btn" title="스크린샷 (Ctrl+Shift+S)"><i class="ri-screenshot-line"></i></button>
          <button class="dtf-btn" id="dtf-external" title="새 창에서 열기"><i class="ri-external-link-line"></i></button>
        </div>
        <div class="dtf-frame-wrap"></div>
      `;
      framesContainer.querySelector('#dtf-back').addEventListener('click', () => {
        const frame = getActiveFrame();
        if (!frame) return;
        if (isElectron && frame.tagName === 'WEBVIEW') { if (frame.canGoBack()) frame.goBack(); }
        else { try { frame.contentWindow.history.back(); } catch {} }
      });
      framesContainer.querySelector('#dtf-forward').addEventListener('click', () => {
        const frame = getActiveFrame();
        if (!frame) return;
        if (isElectron && frame.tagName === 'WEBVIEW') { if (frame.canGoForward()) frame.goForward(); }
        else { try { frame.contentWindow.history.forward(); } catch {} }
      });
      framesContainer.querySelector('#dtf-refresh').addEventListener('click', () => {
        const frame = getActiveFrame();
        if (!frame) return;
        if (isElectron && frame.tagName === 'WEBVIEW') frame.reload();
        else if (frame.src !== 'about:blank') frame.src = frame.src;
      });
      framesContainer.querySelector('#dtf-external').addEventListener('click', () => {
        const t = dynTabs.find(t => t.id === activeDynTabId);
        if (t) window.open(t.url, '_blank');
      });
      framesContainer.querySelector('#dtf-note-btn').addEventListener('click', showUrlNotePopover);
      framesContainer.querySelector('#dtf-split-btn').addEventListener('click', () => window.__toggleSplit());
      framesContainer.querySelector('#dtf-pip-btn').addEventListener('click', () => window.__pip());
      framesContainer.querySelector('#dtf-ss-btn').addEventListener('click', () => window.__screenshot());

      const urlInput = framesContainer.querySelector('#dtf-url-input');
      urlInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const val = urlInput.value.trim();
        if (!val) return;
        const frame = getActiveFrame();
        if (!frame) return;
        let navigateUrl;
        if (/^https?:\/\//i.test(val)) {
          navigateUrl = val;
        } else if (/^[^\s]+\.[^\s]+$/.test(val) && !/\s/.test(val)) {
          navigateUrl = 'https://' + val;
        } else {
          navigateUrl = 'https://www.google.com/search?q=' + encodeURIComponent(val);
        }
        if (frame.tagName === 'WEBVIEW') {
          frame.loadURL(navigateUrl);
        } else {
          frame.src = navigateUrl;
        }
        const tab = dynTabs.find(t => t.id === activeDynTabId);
        if (tab) tab.url = navigateUrl;
        urlInput.blur();
      });
      urlInput.addEventListener('focus', () => urlInput.select());

      framesContainer.querySelector('#dtf-zoom-in').addEventListener('click', () => {
        const frame = getActiveFrame();
        if (!frame || frame.tagName !== 'WEBVIEW') return;
        frame.setZoomLevel(Math.min(5, (frame.getZoomLevel() || 0) + 0.5));
        updateZoomLabel(frame);
      });
      framesContainer.querySelector('#dtf-zoom-out').addEventListener('click', () => {
        const frame = getActiveFrame();
        if (!frame || frame.tagName !== 'WEBVIEW') return;
        frame.setZoomLevel(Math.max(-5, (frame.getZoomLevel() || 0) - 0.5));
        updateZoomLabel(frame);
      });
      framesContainer.querySelector('#dtf-zoom-reset').addEventListener('click', () => {
        const frame = getActiveFrame();
        if (!frame || frame.tagName !== 'WEBVIEW') return;
        frame.setZoomLevel(0);
        updateZoomLabel(frame);
      });
    }

    const frameWrap = framesContainer.querySelector('.dtf-frame-wrap');
    let frame;

    if (isElectron) {
      frame = document.createElement('webview');
      frame.dataset.dynId = id;
      frame.setAttribute('allowpopups', '');
      const partition = containerId ? `persist:container_${containerId}` : 'persist:main';
      frame.setAttribute('partition', partition);
      if (window.electronAPI?.webviewPreloadPath) {
        frame.setAttribute('preload', window.electronAPI.webviewPreloadPath);
      }
      frame.src = url;
      frame.addEventListener('page-title-updated', (e) => {
        tab.title = e.title;
        const sp = document.querySelector(`.dyn-tab[data-dyn-id="${id}"] .dyn-tab-title`);
        if (sp) sp.textContent = e.title;
      });
      frame.addEventListener('page-favicon-updated', (e) => {
        if (e.favicons?.[0]) {
          const img = document.querySelector(`.dyn-tab[data-dyn-id="${id}"] .dyn-tab-favicon`);
          if (img) { img.src = e.favicons[0]; img.style.display = ''; }
        }
      });
      frame.addEventListener('did-navigate', (e) => {
        tab.url = e.url;
        if (activeDynTabId === id) {
          const bar = framesContainer.querySelector('#dtf-url-input');
          if (bar) bar.value = e.url;
        }
        autoFillWebview(frame, e.url);
      });
      frame.addEventListener('did-navigate-in-page', (e) => {
        tab.url = e.url;
        if (activeDynTabId === id) {
          const bar = framesContainer.querySelector('#dtf-url-input');
          if (bar) bar.value = e.url;
        }
      });
      frame.addEventListener('dom-ready', () => {
        autoFillWebview(frame, url);
      });
      frame.addEventListener('did-start-loading', () => {
        const dot = document.querySelector(`.dyn-tab[data-dyn-id="${id}"] .dyn-tab-loading`);
        if (dot) dot.classList.add('active');
      });
      frame.addEventListener('did-stop-loading', () => {
        const dot = document.querySelector(`.dyn-tab[data-dyn-id="${id}"] .dyn-tab-loading`);
        if (dot) dot.classList.remove('active');
      });
      frame.addEventListener('found-in-page', (e) => {
        const countEl = document.getElementById('find-bar-count');
        if (countEl && e.result) {
          countEl.textContent = `${e.result.activeMatchOrdinal}/${e.result.matches}`;
        }
      });
      frame.addEventListener('ipc-message', (e) => {
        if (e.channel === 'pw-submit') {
          const data = e.args[0];
          showPwSaveBar(data, frame);
        } else if (e.channel === 'pw-detected') {
          autoFillWebview(frame, frame.getURL?.() || url);
        } else if (e.channel === 'nav-back') {
          if (frame.canGoBack()) frame.goBack();
        } else if (e.channel === 'nav-forward') {
          if (frame.canGoForward()) frame.goForward();
        } else if (e.channel === 'zoom-changed') {
          const pct = e.args[0];
          const label = document.getElementById('dtf-zoom-label');
          if (label && activeDynTabId === id) label.textContent = pct + '%';
        } else if (e.channel === 'gesture') {
          const dir = e.args[0];
          if (dir === 'left' && frame.canGoBack()) frame.goBack();
          else if (dir === 'right' && frame.canGoForward()) frame.goForward();
          else if (dir === 'down') createDynTab('https://www.google.com', 'Google');
          else if (dir === 'up') closeDynTab(id);
        } else if (e.channel === 'preload-ready') {
          console.log('[LinkFlow] Webview preload ready:', e.args[0]?.domain);
        }
      });
      frame.addEventListener('crashed', () => {
        console.error('[LinkFlow] Webview crashed:', id, url);
        const tabEl = document.querySelector(`.dyn-tab[data-dyn-id="${id}"]`);
        if (tabEl) tabEl.style.opacity = '0.5';
        if (typeof UI !== 'undefined') UI.showToast('페이지가 충돌했습니다. 탭을 클릭하면 새로고침합니다.', 'error');
        frame._crashed = true;
      });
      frame.addEventListener('did-fail-load', (e) => {
        if (e.errorCode === -3) return;
        console.warn('[LinkFlow] Webview load failed:', e.errorCode, e.errorDescription, url);
      });
    } else {
      frame = document.createElement('iframe');
      frame.dataset.dynId = id;
      frame.sandbox = 'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
      frame.src = url;
    }

    frameWrap.appendChild(frame);
    switchToDynTab(id);
    return tab;
  }

  function getActiveFrame() {
    const sel = isElectron ? 'webview.active' : 'iframe.active';
    return document.querySelector(`#dynamic-tab-frames .dtf-frame-wrap ${sel}`);
  }

  function updateZoomLabel(frame) {
    const label = document.getElementById('dtf-zoom-label');
    if (!label || !frame) return;
    if (frame.tagName === 'WEBVIEW' && frame.getZoomFactor) {
      try { label.textContent = Math.round(frame.getZoomFactor() * 100) + '%'; }
      catch { label.textContent = '100%'; }
    } else {
      label.textContent = '100%';
    }
  }

  function removeDynTabUI(id) {
    const idx = dynTabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    dynTabs.splice(idx, 1);

    const tabEl = document.querySelector(`.dyn-tab[data-dyn-id="${id}"]`);
    if (tabEl) tabEl.remove();

    const sel = isElectron ? 'webview' : 'iframe';
    const frame = document.querySelector(`#dynamic-tab-frames ${sel}[data-dyn-id="${id}"]`);
    if (frame) {
      frame.classList.remove('active');
      frame.style.display = 'none';
      setTimeout(() => { try { frame.src = 'about:blank'; frame.remove(); } catch {} }, 3000);
    }

    updateTabDivider();

    if (activeDynTabId === id) {
      if (dynTabs.length > 0) {
        const nearest = dynTabs[Math.min(idx, dynTabs.length - 1)];
        switchToDynTab(nearest.id);
      } else {
        switchTab('bookmarks');
      }
    }
  }

  function closeDynTab(id) {
    const idx = dynTabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const closed = dynTabs[idx];
    if (closed) closedTabHistory.push({ url: closed.url, title: closed.title });
    if (closedTabHistory.length > 20) closedTabHistory.shift();
    dynTabs.splice(idx, 1);

    const tabEl = document.querySelector(`.dyn-tab[data-dyn-id="${id}"]`);
    if (tabEl) tabEl.remove();

    const sel = isElectron ? 'webview' : 'iframe';
    const frame = document.querySelector(`#dynamic-tab-frames ${sel}[data-dyn-id="${id}"]`);
    if (frame) { frame.src = 'about:blank'; frame.remove(); }

    updateTabDivider();

    if (activeDynTabId === id) {
      if (dynTabs.length > 0) {
        const nearest = dynTabs[Math.min(idx, dynTabs.length - 1)];
        switchToDynTab(nearest.id);
      } else {
        switchTab('bookmarks');
      }
    }
  }

  // ═══════ Screens ═══════

  function showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('dashboard-screen').classList.add('hidden');
  }

  function showDashboard() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');

    const user = Auth.getUser();
    document.getElementById('user-display-name').textContent = user.display_name;

    if (isElectron && window.electronAPI?.setPasswordUser) {
      window.electronAPI.setPasswordUser(user.id);
    }

    const adminBtn = document.getElementById('btn-admin');
    if (Auth.isAdmin()) adminBtn.style.display = '';
    else adminBtn.style.display = 'none';

    const clientsBtn = document.getElementById('btn-clients');
    clientsBtn.style.display = 'none';

    const clientsMainTab = document.getElementById('main-tab-clients');
    if (user.team_id) clientsMainTab.style.display = '';
    else clientsMainTab.style.display = 'none';

    Calendar.init();
    Memos.init();
    loadData();

    if (isElectron && window.electronAPI?.listExtensions) {
      renderExtensionToolbar();
    }
    if (isElectron && window.electronAPI?.containerList) {
      window.electronAPI.containerList().then(list => { containers = list || []; });
    }
    startHibernation();

    const hashMatch = location.hash.match(/__open_tab=([^&]+)/);
    if (hashMatch) {
      const tabUrl = decodeURIComponent(hashMatch[1]);
      history.replaceState(null, '', location.pathname + location.search);
      setTimeout(() => createDynTab(tabUrl), 300);
    }
  }

  async function loadData() {
    try {
      const [catData, bmData] = await Promise.all([
        Auth.request('/categories'),
        Auth.request('/bookmarks'),
      ]);
      categories = [...catData.own, ...(catData.shared || [])];
      bookmarks = bmData.own || [];
      sharedBookmarks = bmData.shared || [];
      renderCategoryTabs();
      renderBookmarks();
      checkHealthAll();
    } catch (e) {
      UI.showToast('데이터 로딩 실패: ' + e.message, 'error');
    }
  }

  // ═══════ Category Tabs ═══════

  function renderCategoryTabs() {
    const container = document.getElementById('category-tabs');
    let html = `<button class="cat-tab ${activeCategory === 'all' ? 'active' : ''}" data-cat="all"><i class="ri-apps-line"></i> 전체</button>`;
    categories.forEach(c => {
      html += `<button class="cat-tab ${activeCategory === c.id ? 'active' : ''}" data-cat="${c.id}">${c.icon} ${c.name}</button>`;
    });
    html += `<button class="cat-tab" data-cat="uncategorized"><i class="ri-folder-unknow-line"></i> 미분류</button>`;
    container.innerHTML = html;

    container.querySelectorAll('.cat-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeCategory = tab.dataset.cat;
        renderCategoryTabs();
        renderBookmarks();
      });
    });
  }

  // ═══════ Bookmarks Render ═══════

  function renderBookmarks() {
    const grid = document.getElementById('bookmarks-grid');
    const empty = document.getElementById('empty-state');
    const search = document.getElementById('search-input').value.toLowerCase();

    let filtered = bookmarks.filter(b => {
      if (activeCategory === 'all') return true;
      if (activeCategory === 'uncategorized') return !b.category_id;
      return b.category_id === activeCategory;
    });

    if (search) {
      filtered = filtered.filter(b =>
        b.title.toLowerCase().includes(search) ||
        (b.description || '').toLowerCase().includes(search) ||
        b.url.toLowerCase().includes(search)
      );
    }

    let sharedFiltered = sharedBookmarks;
    if (search) {
      sharedFiltered = sharedFiltered.filter(b =>
        b.title.toLowerCase().includes(search) ||
        (b.description || '').toLowerCase().includes(search)
      );
    }

    if (filtered.length === 0 && sharedFiltered.length === 0) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');

    let html = '';
    const typeOrder = UI.SERVICE_TYPE_ORDER;
    const grouped = {};
    filtered.forEach(b => {
      const t = b.service_type || 'web';
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push(b);
    });

    const usedTypes = typeOrder.filter(t => grouped[t]?.length);
    const showHeaders = usedTypes.length > 1;

    usedTypes.forEach(t => {
      const info = UI.getTypeInfo(t);
      if (showHeaders) {
        html += `<div class="type-section-title"><i class="${info.icon}"></i> ${info.label}</div>`;
      }
      const sorted = grouped[t].sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0));
      html += sorted.map(b => cardHTML(b, false)).join('');
    });

    if (sharedFiltered.length > 0 && activeCategory === 'all') {
      html += `<div class="type-section-title shared"><i class="ri-share-line"></i> 공용 북마크</div>`;
      html += sharedFiltered.map(b => cardHTML(b, true)).join('');
    }

    grid.innerHTML = html;

    grid.querySelectorAll('.bookmark-card[data-id]').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.bookmark-actions')) return;
        const bm = [...bookmarks, ...sharedBookmarks].find(x => x.id === card.dataset.id);
        if (bm) openInBrowser(bm);
      });

      card.addEventListener('dragstart', e => {
        dragSrcId = card.dataset.id;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        document.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
      });
      card.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', e => {
        e.preventDefault();
        card.classList.remove('drag-over');
        if (dragSrcId && dragSrcId !== card.dataset.id) {
          handleReorder(dragSrcId, card.dataset.id);
        }
      });
    });

    grid.querySelectorAll('.btn-pin-bm').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          const updated = await Auth.request(`/bookmarks/${btn.dataset.id}/pin`, { method: 'PATCH' });
          const bm = bookmarks.find(b => b.id === btn.dataset.id);
          if (bm) bm.is_pinned = updated.is_pinned;
          renderBookmarks();
        } catch (err) { UI.showToast(err.message, 'error'); }
      });
    });
    grid.querySelectorAll('.btn-edit-bm').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); openEditBookmark(btn.dataset.id); });
    });
    grid.querySelectorAll('.btn-delete-bm').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const ok = await UI.confirm('삭제 확인', '이 북마크를 삭제하시겠습니까?');
        if (ok) deleteBookmark(btn.dataset.id);
      });
    });
  }

  function cardHTML(b, isShared) {
    const type = b.service_type || 'web';
    const typeInfo = UI.getTypeInfo(type);
    const health = healthCache[b.id];
    let statusClass = 'status-unknown';
    if (health === 'checking') statusClass = 'status-checking';
    else if (health === 'online') statusClass = 'status-online';
    else if (health === 'offline') statusClass = 'status-offline';

    let iconContent;
    if (b.icon_url) {
      iconContent = `<img src="${b.icon_url}" alt="" onerror="this.style.display='none';this.parentNode.innerHTML='<i class=\\'${typeInfo.icon}\\'></i>'" />`;
    } else if (typeInfo.useFavicon && b.url) {
      try {
        const domain = new URL(b.url).hostname;
        iconContent = `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=64" alt="" onerror="this.style.display='none';this.parentNode.innerHTML='<i class=\\'${typeInfo.icon}\\'></i>'" />`;
      } catch { iconContent = `<i class="${typeInfo.icon}"></i>`; }
    } else {
      iconContent = `<i class="${typeInfo.icon}"></i>`;
    }

    const catName = b.categories?.name ? `${b.categories.icon || ''} ${b.categories.name}` : '';

    return `
      <div class="bookmark-card" data-id="${b.id}" draggable="${isShared ? 'false' : 'true'}">
        ${isShared ? '<span class="bookmark-shared-badge">공용</span>' : ''}
        ${!isShared ? `<div class="bookmark-actions">
          <button class="icon-btn btn-pin-bm ${b.is_pinned ? 'pinned' : ''}" data-id="${b.id}" title="${b.is_pinned ? '고정 해제' : '상단 고정'}"><i class="${b.is_pinned ? 'ri-pushpin-fill' : 'ri-pushpin-line'}"></i></button>
          <button class="icon-btn btn-edit-bm" data-id="${b.id}" title="수정"><i class="ri-edit-line"></i></button>
          <button class="icon-btn btn-delete-bm" data-id="${b.id}" title="삭제"><i class="ri-delete-bin-line"></i></button>
        </div>` : ''}
        <div class="bookmark-card-header">
          <div class="bookmark-icon type-${type}">${iconContent}</div>
          <div class="bookmark-info">
            <div class="bookmark-title">${escapeHtml(b.title)}</div>
            ${b.description ? `<div class="bookmark-desc">${escapeHtml(b.description)}</div>` : ''}
          </div>
        </div>
        <div class="bookmark-meta">
          <span class="bookmark-type-badge">${catName || typeInfo.label}</span>
          <span class="bookmark-status ${statusClass}" title="${health || '확인 안됨'}"></span>
        </div>
      </div>`;
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ═══════ Health Check ═══════

  async function checkHealthAll() {
    const urlMap = {};
    [...bookmarks, ...sharedBookmarks].forEach(b => {
      const url = b.health_check_url || b.url;
      if (url) { urlMap[b.id] = url; healthCache[b.id] = 'checking'; }
    });
    renderBookmarks();
    if (Object.keys(urlMap).length === 0) return;
    try {
      const result = await Auth.request('/health/batch', {
        method: 'POST', body: JSON.stringify({ urls: urlMap }),
      });
      Object.entries(result).forEach(([id, info]) => { healthCache[id] = info.status; });
    } catch {
      Object.keys(urlMap).forEach(id => { healthCache[id] = 'unknown'; });
    }
    renderBookmarks();
  }

  // ═══════ Bookmark CRUD ═══════

  function openAddBookmark() {
    document.getElementById('bookmark-modal-title').textContent = '북마크 추가';
    document.getElementById('bm-submit-btn').textContent = '추가';
    document.getElementById('bookmark-form').reset();
    document.getElementById('bm-edit-id').value = '';
    document.getElementById('bm-open-mode').value = 'auto';
    const sharedWrap = document.getElementById('bm-shared-wrap');
    if (Auth.isAdmin()) sharedWrap.classList.remove('hidden');
    else sharedWrap.classList.add('hidden');
    document.getElementById('bm-shared').checked = false;
    populateCategorySelect();
    UI.openModal('bookmark-modal');
  }

  function openEditBookmark(id) {
    const bm = bookmarks.find(b => b.id === id);
    if (!bm) return;
    document.getElementById('bookmark-modal-title').textContent = '북마크 수정';
    document.getElementById('bm-submit-btn').textContent = '저장';
    document.getElementById('bm-edit-id').value = id;
    document.getElementById('bm-title').value = bm.title;
    document.getElementById('bm-url').value = bm.url;
    document.getElementById('bm-desc').value = bm.description || '';
    document.getElementById('bm-type').value = bm.service_type || 'web';
    document.getElementById('bm-health').value = bm.health_check_url || '';
    document.getElementById('bm-icon').value = bm.icon_url || '';
    document.getElementById('bm-open-mode').value = bm.open_mode || 'auto';
    const sharedWrap = document.getElementById('bm-shared-wrap');
    if (Auth.isAdmin()) sharedWrap.classList.remove('hidden');
    else sharedWrap.classList.add('hidden');
    document.getElementById('bm-shared').checked = bm.is_shared || false;
    populateCategorySelect(bm.category_id);
    UI.openModal('bookmark-modal');
  }

  function populateCategorySelect(selected = '') {
    const sel = document.getElementById('bm-category');
    sel.innerHTML = '<option value="">없음</option>';
    categories.forEach(c => {
      sel.innerHTML += `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.icon} ${c.name}</option>`;
    });
  }

  async function saveBookmark(e) {
    e.preventDefault();
    const id = document.getElementById('bm-edit-id').value;
    const data = {
      title: document.getElementById('bm-title').value.trim(),
      url: document.getElementById('bm-url').value.trim(),
      description: document.getElementById('bm-desc').value.trim(),
      category_id: document.getElementById('bm-category').value || null,
      service_type: document.getElementById('bm-type').value,
      health_check_url: document.getElementById('bm-health').value.trim() || null,
      icon_url: document.getElementById('bm-icon').value.trim() || null,
      is_shared: Auth.isAdmin() ? document.getElementById('bm-shared').checked : false,
      open_mode: document.getElementById('bm-open-mode').value,
    };
    try {
      if (id) {
        await Auth.request(`/bookmarks/${id}`, { method: 'PUT', body: JSON.stringify(data) });
        UI.showToast('북마크가 수정되었습니다', 'success');
      } else {
        await Auth.request('/bookmarks', { method: 'POST', body: JSON.stringify(data) });
        UI.showToast('북마크가 추가되었습니다', 'success');
      }
      UI.closeModal('bookmark-modal');
      loadData();
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  async function deleteBookmark(id) {
    try {
      await Auth.request(`/bookmarks/${id}`, { method: 'DELETE' });
      UI.showToast('삭제되었습니다', 'success');
      loadData();
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  async function handleReorder(fromId, toId) {
    const fromIdx = bookmarks.findIndex(b => b.id === fromId);
    const toIdx = bookmarks.findIndex(b => b.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = bookmarks.splice(fromIdx, 1);
    bookmarks.splice(toIdx, 0, moved);
    const items = bookmarks.map((b, i) => ({ id: b.id, sort_order: i }));
    renderBookmarks();
    try {
      await Auth.request('/bookmarks/reorder', { method: 'PATCH', body: JSON.stringify({ items }) });
    } catch { UI.showToast('순서 변경 실패', 'error'); loadData(); }
  }

  // ═══════ Categories ═══════

  function renderCategoryList() {
    const container = document.getElementById('category-list');
    container.innerHTML = categories.filter(c => c.user_id || !c.is_shared).map(c => `
      <div class="category-manage-item">
        <span class="cat-icon-display">${c.icon}</span>
        <span class="cat-name-display">${escapeHtml(c.name)}</span>
        <button class="icon-btn btn-edit-cat" data-id="${c.id}" title="수정"><i class="ri-edit-line"></i></button>
        <button class="icon-btn btn-delete-cat" data-id="${c.id}" title="삭제"><i class="ri-delete-bin-line"></i></button>
      </div>`).join('');
    container.querySelectorAll('.btn-edit-cat').forEach(btn => btn.addEventListener('click', () => openEditCategory(btn.dataset.id)));
    container.querySelectorAll('.btn-delete-cat').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await UI.confirm('삭제 확인', '이 카테고리를 삭제하시겠습니까?');
        if (ok) deleteCategory(btn.dataset.id);
      });
    });
  }

  function openAddCategory() {
    document.getElementById('category-modal-title').textContent = '카테고리 추가';
    document.getElementById('category-form').reset();
    document.getElementById('cat-icon').value = '📁';
    document.getElementById('cat-edit-id').value = '';
    UI.openModal('category-modal');
  }

  function openEditCategory(id) {
    const cat = categories.find(c => c.id === id);
    if (!cat) return;
    document.getElementById('category-modal-title').textContent = '카테고리 수정';
    document.getElementById('cat-icon').value = cat.icon;
    document.getElementById('cat-name').value = cat.name;
    document.getElementById('cat-edit-id').value = id;
    UI.openModal('category-modal');
  }

  async function saveCategory(e) {
    e.preventDefault();
    const id = document.getElementById('cat-edit-id').value;
    const data = { name: document.getElementById('cat-name').value.trim(), icon: document.getElementById('cat-icon').value.trim() || '📁' };
    try {
      if (id) {
        await Auth.request(`/categories/${id}`, { method: 'PUT', body: JSON.stringify(data) });
        UI.showToast('카테고리가 수정되었습니다', 'success');
      } else {
        await Auth.request('/categories', { method: 'POST', body: JSON.stringify(data) });
        UI.showToast('카테고리가 추가되었습니다', 'success');
      }
      UI.closeModal('category-modal');
      loadData();
      renderCategoryList();
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  async function deleteCategory(id) {
    try {
      await Auth.request(`/categories/${id}`, { method: 'DELETE' });
      UI.showToast('삭제되었습니다', 'success');
      if (activeCategory === id) activeCategory = 'all';
      loadData();
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  // ═══════ Settings ═══════

  function openSettings() {
    const user = Auth.getUser();
    document.getElementById('setting-display-name').value = user.display_name || '';
    document.getElementById('setting-lock-enabled').checked = user.lock_enabled || false;
    document.getElementById('setting-lock-timeout').value = String(user.lock_timeout || 300);
    document.getElementById('setting-pin').value = user.pin_code || '';
    renderCategoryList();
    const versionEl = document.getElementById('app-version-display');
    if (versionEl) {
      const ver = window.electronAPI?.getAppVersion ? window.electronAPI.getAppVersion() : '';
      versionEl.textContent = ver ? `LinkFlow v${ver}` : 'LinkFlow (웹 버전)';
    }
    const pwSection = document.getElementById('pw-manage-section');
    const extSection = document.getElementById('ext-manage-section');
    if (isElectron && window.electronAPI) {
      if (pwSection) pwSection.style.display = '';
      if (extSection) extSection.style.display = '';
      renderSavedPasswords();
      renderExtensionList();
    } else {
      if (pwSection) pwSection.style.display = 'none';
      if (extSection) extSection.style.display = 'none';
    }
    UI.showPanel('settings-panel');
  }

  async function saveProfile() {
    const name = document.getElementById('setting-display-name').value.trim();
    if (!name) return UI.showToast('이름을 입력하세요', 'error');
    try {
      await Auth.request('/user/settings', { method: 'PUT', body: JSON.stringify({ display_name: name }) });
      Auth.updateUser({ display_name: name });
      document.getElementById('user-display-name').textContent = name;
      UI.showToast('저장되었습니다', 'success');
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  async function saveLockSettings() {
    const enabled = document.getElementById('setting-lock-enabled').checked;
    const timeout = parseInt(document.getElementById('setting-lock-timeout').value, 10);
    const pin = document.getElementById('setting-pin').value.trim();
    if (enabled && !pin) return UI.showToast('PIN을 설정해주세요', 'error');
    if (pin && !/^\d{1,4}$/.test(pin)) return UI.showToast('PIN은 숫자 1~4자리입니다', 'error');
    try {
      await Auth.request('/user/settings', {
        method: 'PUT',
        body: JSON.stringify({ lock_enabled: enabled, lock_timeout: timeout, pin_code: pin || null }),
      });
      Auth.updateUser({ lock_enabled: enabled, lock_timeout: timeout, pin_code: pin || null });
      if (enabled) Auth.startLockTimer(); else Auth.stopLockTimer();
      UI.showToast('잠금 설정이 저장되었습니다', 'success');
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  // ═══════ Admin ═══════

  let adminTeams = [];

  async function openAdmin() {
    UI.showPanel('admin-panel');
    try {
      const [users, teams] = await Promise.all([
        Auth.request('/admin/users'),
        Auth.request('/admin/teams'),
      ]);
      adminTeams = teams;
      renderAdminTeams(teams);
      renderAdminUsers(users, teams);
      populateTeamSelect('new-user-team', teams);
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  function populateTeamSelect(selectId, teams) {
    const sel = document.getElementById(selectId);
    sel.innerHTML = '<option value="">없음</option>' +
      teams.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  }

  function renderAdminTeams(teams) {
    const list = document.getElementById('admin-team-list');
    if (!teams.length) {
      list.innerHTML = '<p class="empty-hint">등록된 팀이 없습니다</p>';
      return;
    }
    list.innerHTML = teams.map(t => `
      <div class="team-item">
        <i class="ri-team-line"></i>
        <span class="team-name">${escapeHtml(t.name)}</span>
        ${t.description ? `<span class="team-desc">${escapeHtml(t.description)}</span>` : ''}
        <div style="flex:1"></div>
        <button class="icon-btn btn-delete-team" data-id="${t.id}" data-name="${escapeHtml(t.name)}" title="삭제"><i class="ri-delete-bin-line"></i></button>
      </div>`).join('');

    list.querySelectorAll('.btn-delete-team').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await UI.confirm('팀 삭제', `${btn.dataset.name} 팀을 삭제하시겠습니까? 소속된 사용자의 팀이 해제됩니다.`);
        if (ok) {
          try {
            await Auth.request(`/admin/teams/${btn.dataset.id}`, { method: 'DELETE' });
            UI.showToast('삭제되었습니다', 'success');
            openAdmin();
          } catch (err) { UI.showToast(err.message, 'error'); }
        }
      });
    });
  }

  async function createTeam() {
    const nameInput = document.getElementById('new-team-name');
    const name = nameInput.value.trim();
    if (!name) return UI.showToast('팀 이름을 입력하세요', 'error');
    try {
      await Auth.request('/admin/teams', { method: 'POST', body: JSON.stringify({ name }) });
      nameInput.value = '';
      UI.showToast(`${name} 팀이 생성되었습니다`, 'success');
      openAdmin();
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  function renderAdminUsers(users, teams) {
    const teamMap = {};
    teams.forEach(t => { teamMap[t.id] = t.name; });
    const list = document.getElementById('admin-user-list');
    list.innerHTML = users.map(u => `
      <div class="user-item">
        <div class="user-item-avatar">${(u.display_name || u.username).charAt(0).toUpperCase()}</div>
        <div class="user-item-info">
          <div class="user-name">${escapeHtml(u.display_name)}${u.is_admin ? '<span class="admin-badge">관리자</span>' : ''}${u.team_id ? `<span class="team-badge">${escapeHtml(teamMap[u.team_id] || '')}</span>` : ''}</div>
          <div class="user-id">${escapeHtml(u.username)}</div>
        </div>
        <div class="user-item-actions">
          ${!u.is_admin ? `
            <select class="select-input select-sm user-team-select" data-id="${u.id}" title="팀 변경">
              <option value="">팀 없음</option>
              ${teams.map(t => `<option value="${t.id}" ${u.team_id === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
            </select>
            <button class="icon-btn btn-reset-pw" data-id="${u.id}" data-name="${escapeHtml(u.display_name)}" title="비밀번호 초기화"><i class="ri-key-line"></i></button>
            <button class="icon-btn btn-delete-user" data-id="${u.id}" data-name="${escapeHtml(u.display_name)}" title="삭제"><i class="ri-delete-bin-line"></i></button>
          ` : ''}
        </div>
      </div>`).join('');

    list.querySelectorAll('.user-team-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        try {
          await Auth.request(`/admin/users/${sel.dataset.id}/team`, {
            method: 'PATCH',
            body: JSON.stringify({ team_id: sel.value || null }),
          });
          UI.showToast('팀이 변경되었습니다', 'success');
        } catch (err) { UI.showToast(err.message, 'error'); }
      });
    });
    list.querySelectorAll('.btn-reset-pw').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await UI.confirm('비밀번호 초기화', `${btn.dataset.name}의 비밀번호를 0000으로 초기화하시겠습니까?`);
        if (ok) {
          try {
            await Auth.request(`/admin/users/${btn.dataset.id}/reset-password`, { method: 'POST', body: JSON.stringify({ new_password: '0000' }) });
            UI.showToast('비밀번호가 0000으로 초기화되었습니다', 'success');
          } catch (err) { UI.showToast(err.message, 'error'); }
        }
      });
    });
    list.querySelectorAll('.btn-delete-user').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await UI.confirm('사용자 삭제', `${btn.dataset.name} 사용자를 삭제하시겠습니까?`);
        if (ok) {
          try {
            await Auth.request(`/admin/users/${btn.dataset.id}`, { method: 'DELETE' });
            UI.showToast('삭제되었습니다', 'success');
            openAdmin();
          } catch (err) { UI.showToast(err.message, 'error'); }
        }
      });
    });
  }

  async function createUser(e) {
    e.preventDefault();
    const teamVal = document.getElementById('new-user-team').value;
    const data = {
      username: document.getElementById('new-user-id').value.trim(),
      password: document.getElementById('new-user-pw').value,
      display_name: document.getElementById('new-user-name').value.trim(),
    };
    if (teamVal) data.team_id = teamVal;
    try {
      await Auth.request('/admin/users', { method: 'POST', body: JSON.stringify(data) });
      UI.showToast(`${data.display_name} 사용자가 생성되었습니다`, 'success');
      UI.closeModal('user-modal');
      document.getElementById('user-form').reset();
      openAdmin();
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  // ═══════ Clients (거래처) ═══════

  let clientsList = [];
  let currentClientId = null;
  let currentClientData = null;
  let clientsTabSearchQuery = '';

  async function openClientsPanel() {
    UI.showPanel('clients-panel');
    await loadClients();
  }

  async function loadClients() {
    try {
      clientsList = await Auth.request('/clients');
      renderClientsList();
    } catch (err) {
      if (err.message === 'No team assigned') {
        document.getElementById('clients-list').innerHTML = '<p class="empty-hint">소속된 팀이 없습니다</p>';
      } else {
        UI.showToast(err.message, 'error');
      }
    }
  }

  function renderClientsList() {
    const list = document.getElementById('clients-list');
    if (!clientsList.length) {
      list.innerHTML = '<p class="empty-hint">등록된 거래처가 없습니다</p>';
      return;
    }
    list.innerHTML = clientsList.map(c => `
      <div class="client-card" data-id="${c.id}">
        <div class="client-card-icon"><i class="ri-building-2-line"></i></div>
        <div class="client-card-body">
          <div class="client-card-name">${escapeHtml(c.name)}</div>
          ${c.gyeongli_id ? `<div class="client-card-sub">${escapeHtml(c.gyeongli_id)}</div>` : ''}
        </div>
        <i class="ri-arrow-right-s-line client-card-arrow"></i>
      </div>`).join('');

    list.querySelectorAll('.client-card').forEach(card => {
      card.addEventListener('click', () => openClientDetail(card.dataset.id));
    });
  }

  async function loadClientsTab() {
    try {
      clientsList = await Auth.request('/clients');
      renderClientsTabList();
    } catch (err) {
      if (err.message === 'No team assigned') {
        document.getElementById('clients-tab-list').innerHTML = '<p class="empty-hint">소속된 팀이 없습니다</p>';
      } else {
        UI.showToast(err.message, 'error');
      }
    }
  }

  function renderClientsTabList() {
    const list = document.getElementById('clients-tab-list');
    const q = clientsTabSearchQuery.toLowerCase();
    let filtered = clientsList;
    if (q) {
      filtered = clientsList.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.gyeongli_id || '').toLowerCase().includes(q) ||
        (c.memo || '').toLowerCase().includes(q)
      );
    }

    if (!filtered.length) {
      list.innerHTML = q
        ? '<p class="empty-hint">검색 결과가 없습니다</p>'
        : '<p class="empty-hint">등록된 거래처가 없습니다</p>';
      return;
    }

    list.innerHTML = filtered.map(c => {
      const memoSnippet = c.memo ? c.memo.substring(0, 60) : '';
      return `
      <div class="client-tab-card" data-id="${c.id}">
        <div class="client-tab-icon"><i class="ri-building-2-line"></i></div>
        <div class="client-tab-body">
          <div class="client-tab-name">${escapeHtml(c.name)}</div>
          ${c.gyeongli_id ? `<div class="client-tab-id">${escapeHtml(c.gyeongli_id)}</div>` : ''}
          ${memoSnippet ? `<div class="client-tab-memo">${escapeHtml(memoSnippet)}${c.memo.length > 60 ? '...' : ''}</div>` : ''}
        </div>
        <i class="ri-arrow-right-s-line client-tab-arrow"></i>
      </div>`;
    }).join('');

    list.querySelectorAll('.client-tab-card').forEach(card => {
      card.addEventListener('click', () => {
        openClientDetail(card.dataset.id);
      });
    });
  }

  async function openClientDetail(clientId) {
    currentClientId = clientId;
    try {
      currentClientData = await Auth.request(`/clients/${clientId}`);
      document.getElementById('client-detail-title').textContent = currentClientData.name;
      document.getElementById('client-gyeongli-id').textContent = currentClientData.gyeongli_id || '-';
      const pwEl = document.getElementById('client-gyeongli-pw');
      pwEl.textContent = '••••••';
      pwEl.classList.add('cred-masked');
      pwEl._realValue = currentClientData.gyeongli_pw || '';
      document.getElementById('client-memo-text').textContent = currentClientData.memo || '-';

      await Promise.all([loadClientShortcuts(clientId), loadClientEvents(clientId)]);

      UI.hidePanel('clients-panel');
      UI.showPanel('client-detail-panel');
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  async function loadClientShortcuts(clientId) {
    try {
      const shortcuts = await Auth.request(`/clients/${clientId}/shortcuts`);
      renderClientShortcuts(shortcuts);
    } catch { renderClientShortcuts([]); }
  }

  function renderClientShortcuts(shortcuts) {
    const list = document.getElementById('client-shortcuts-list');
    if (!shortcuts.length) {
      list.innerHTML = '<p class="empty-hint">바로가기가 없습니다</p>';
      return;
    }
    list.innerHTML = shortcuts.map(s => `
      <div class="shortcut-card" data-id="${s.id}">
        <span class="shortcut-icon">${s.icon || '🔗'}</span>
        <a class="shortcut-link" href="${escapeHtml(s.url)}" target="_blank" title="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>
        <button class="icon-btn btn-open-shortcut" data-url="${escapeHtml(s.url)}" title="탭에서 열기"><i class="ri-external-link-line"></i></button>
        <button class="icon-btn btn-delete-shortcut" data-id="${s.id}" title="삭제"><i class="ri-delete-bin-line"></i></button>
      </div>`).join('');

    list.querySelectorAll('.btn-open-shortcut').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        createDynTab(btn.dataset.url);
      });
    });
    list.querySelectorAll('.btn-delete-shortcut').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const ok = await UI.confirm('바로가기 삭제', '이 바로가기를 삭제하시겠습니까?');
        if (!ok) return;
        try {
          await Auth.request(`/clients/${currentClientId}/shortcuts/${btn.dataset.id}`, { method: 'DELETE' });
          UI.showToast('삭제되었습니다', 'success');
          loadClientShortcuts(currentClientId);
        } catch (err) { UI.showToast(err.message, 'error'); }
      });
    });
  }

  async function loadClientEvents(clientId) {
    try {
      const events = await Auth.request(`/clients/${clientId}/events`);
      renderClientEvents(events);
    } catch { renderClientEvents([]); }
  }

  function renderClientEvents(events) {
    const list = document.getElementById('client-events-list');
    if (!events.length) {
      list.innerHTML = '<p class="empty-hint">관련 일정이 없습니다</p>';
      return;
    }
    list.innerHTML = events.slice(0, 20).map(ev => `
      <div class="client-event-item">
        <span class="client-event-dot" style="background:${ev.color}"></span>
        <span class="client-event-date">${ev.start_date}</span>
        <span class="client-event-title">${escapeHtml(ev.title)}</span>
        ${ev.is_done ? '<i class="ri-checkbox-circle-fill" style="color:var(--success)"></i>' : ''}
      </div>`).join('');
  }

  function openAddClient() {
    document.getElementById('client-modal-title').textContent = '거래처 추가';
    document.getElementById('cl-submit-btn').textContent = '추가';
    document.getElementById('client-form').reset();
    document.getElementById('cl-edit-id').value = '';
    UI.openModal('client-modal');
  }

  function openEditClient() {
    if (!currentClientData) return;
    document.getElementById('client-modal-title').textContent = '거래처 수정';
    document.getElementById('cl-submit-btn').textContent = '저장';
    document.getElementById('cl-edit-id').value = currentClientId;
    document.getElementById('cl-name').value = currentClientData.name;
    document.getElementById('cl-gyeongli-id').value = currentClientData.gyeongli_id || '';
    document.getElementById('cl-gyeongli-pw').value = '';
    document.getElementById('cl-memo').value = currentClientData.memo || '';
    UI.openModal('client-modal');
  }

  async function saveClient(e) {
    e.preventDefault();
    const editId = document.getElementById('cl-edit-id').value;
    const data = {
      name: document.getElementById('cl-name').value.trim(),
      gyeongli_id: document.getElementById('cl-gyeongli-id').value.trim() || null,
      gyeongli_pw: document.getElementById('cl-gyeongli-pw').value || null,
      memo: document.getElementById('cl-memo').value.trim() || null,
    };
    try {
      if (editId) {
        if (!data.gyeongli_pw) delete data.gyeongli_pw;
        await Auth.request(`/clients/${editId}`, { method: 'PUT', body: JSON.stringify(data) });
        UI.showToast('거래처가 수정되었습니다', 'success');
        UI.closeModal('client-modal');
        openClientDetail(editId);
        loadClientsTab();
      } else {
        await Auth.request('/clients', { method: 'POST', body: JSON.stringify(data) });
        UI.showToast('거래처가 추가되었습니다', 'success');
        UI.closeModal('client-modal');
        loadClients();
        loadClientsTab();
      }
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  async function deleteClient() {
    if (!currentClientId) return;
    const ok = await UI.confirm('거래처 삭제', '이 거래처를 삭제하시겠습니까? 바로가기도 모두 삭제됩니다.');
    if (!ok) return;
    try {
      await Auth.request(`/clients/${currentClientId}`, { method: 'DELETE' });
      UI.showToast('삭제되었습니다', 'success');
      UI.hidePanel('client-detail-panel');
      loadClients();
      loadClientsTab();
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  function openAddShortcut() {
    document.getElementById('shortcut-modal-title').textContent = '바로가기 추가';
    document.getElementById('sc-submit-btn').textContent = '추가';
    document.getElementById('shortcut-form').reset();
    document.getElementById('sc-edit-id').value = '';
    document.getElementById('sc-client-id').value = currentClientId;
    UI.openModal('shortcut-modal');
  }

  async function saveShortcut(e) {
    e.preventDefault();
    const clientId = document.getElementById('sc-client-id').value;
    const editId = document.getElementById('sc-edit-id').value;
    const data = {
      title: document.getElementById('sc-title').value.trim(),
      url: document.getElementById('sc-url').value.trim(),
      icon: document.getElementById('sc-icon').value.trim() || '',
    };
    try {
      if (editId) {
        await Auth.request(`/clients/${clientId}/shortcuts/${editId}`, { method: 'PUT', body: JSON.stringify(data) });
        UI.showToast('바로가기가 수정되었습니다', 'success');
      } else {
        await Auth.request(`/clients/${clientId}/shortcuts`, { method: 'POST', body: JSON.stringify(data) });
        UI.showToast('바로가기가 추가되었습니다', 'success');
      }
      UI.closeModal('shortcut-modal');
      loadClientShortcuts(clientId);
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  async function changePassword(e) {
    e.preventDefault();
    const current = document.getElementById('pw-current').value;
    const newPw = document.getElementById('pw-new').value;
    const confirmPw = document.getElementById('pw-confirm').value;
    if (newPw !== confirmPw) return UI.showToast('새 비밀번호가 일치하지 않습니다', 'error');
    try {
      await Auth.request('/user/password', { method: 'PUT', body: JSON.stringify({ current_password: current, new_password: newPw }) });
      UI.showToast('비밀번호가 변경되었습니다', 'success');
      UI.closeModal('pw-modal');
      document.getElementById('pw-form').reset();
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  // ═══════ Password Manager (Electron only) ═══════

  let pendingPwData = null;
  let pendingPwFrame = null;

  async function autoFillWebview(frame, urlStr) {
    if (!window.electronAPI) return;
    try {
      const hostname = new URL(urlStr).hostname;
      const creds = await window.electronAPI.getPasswords(hostname);
      if (creds?.length && frame.send) {
        frame.send('pw-fill', creds);
        setTimeout(() => { try { frame.send('pw-fill', creds); } catch {} }, 1000);
        setTimeout(() => { try { frame.send('pw-fill', creds); } catch {} }, 2500);
      }
    } catch {}
  }

  function showPwSaveBar(data, frame) {
    if (!window.electronAPI) return;
    pendingPwData = data;
    pendingPwFrame = frame;
    const bar = document.getElementById('pw-save-bar');
    if (!bar) return;
    const domainEl = document.getElementById('pw-save-domain');
    if (domainEl) domainEl.textContent = `(${data.domain})`;
    const userEl = document.getElementById('pw-save-user');
    if (userEl) userEl.textContent = data.username || '';
    bar.classList.remove('hidden');
  }

  function hidePwSaveBar() {
    const bar = document.getElementById('pw-save-bar');
    if (bar) bar.classList.add('hidden');
    pendingPwData = null;
    pendingPwFrame = null;
  }

  async function handlePwSave() {
    if (!pendingPwData || !window.electronAPI) return;
    await window.electronAPI.savePassword(pendingPwData);
    UI.showToast('비밀번호가 저장되었습니다', 'success');
    hidePwSaveBar();
  }

  async function renderSavedPasswords() {
    const container = document.getElementById('saved-pw-list');
    if (!container || !window.electronAPI) return;
    const all = await window.electronAPI.getAllPasswords();
    const domains = Object.keys(all);
    if (!domains.length) {
      container.innerHTML = '<p style="font-size:13px;color:var(--text-muted);padding:8px 0;">저장된 비밀번호가 없습니다</p>';
      return;
    }
    container.innerHTML = domains.map(domain => {
      return all[domain].map(c => `
        <div class="saved-pw-item" data-domain="${domain}" data-user="${escapeHtml(c.username)}">
          <img class="saved-pw-favicon" src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" onerror="this.style.display='none'" />
          <div class="saved-pw-info">
            <div class="saved-pw-domain">${escapeHtml(domain)}</div>
            <div class="saved-pw-user">${escapeHtml(c.username)}</div>
          </div>
          <button class="icon-btn saved-pw-del" title="삭제"><i class="ri-delete-bin-line"></i></button>
        </div>`).join('');
    }).join('');
    container.querySelectorAll('.saved-pw-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.saved-pw-item');
        await window.electronAPI.deletePassword({
          domain: item.dataset.domain,
          username: item.dataset.user,
        });
        UI.showToast('삭제되었습니다', 'success');
        renderSavedPasswords();
      });
    });
  }

  // ═══════ Extension Management ═══════

  async function renderExtensionList() {
    const container = document.getElementById('ext-list');
    if (!container || !window.electronAPI?.listExtensions) return;
    const exts = await window.electronAPI.listExtensions();
    if (!exts.length) {
      container.innerHTML = '<p style="font-size:13px;color:var(--text-muted);padding:4px 0;">설치된 확장 프로그램이 없습니다</p>';
    } else {
      container.innerHTML = exts.map(ext => `
        <div class="ext-item" data-ext-id="${ext.id}">
          <img class="ext-icon" src="${escapeHtml(ext.icon)}" onerror="this.style.display='none'" />
          <div class="ext-info">
            <div class="ext-name">${escapeHtml(ext.name)}</div>
            <div class="ext-desc">${escapeHtml(ext.version)}${ext.description ? ' — ' + escapeHtml(ext.description).substring(0, 60) : ''}</div>
          </div>
          <button class="icon-btn ext-remove-btn" title="제거"><i class="ri-delete-bin-line"></i></button>
        </div>
      `).join('');
      container.querySelectorAll('.ext-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const item = btn.closest('.ext-item');
          const result = await window.electronAPI.removeExtension(item.dataset.extId);
          if (result.ok) {
            UI.showToast('확장 프로그램이 제거되었습니다', 'success');
            renderExtensionList();
            renderExtensionToolbar();
          } else {
            UI.showToast(result.error || '제거 실패', 'error');
          }
        });
      });
    }
  }

  async function renderExtensionToolbar() {
    const toolbar = document.getElementById('ext-toolbar');
    if (!toolbar || !window.electronAPI?.listExtensions) return;
    const exts = await window.electronAPI.listExtensions();
    if (!exts.length) {
      toolbar.style.display = 'none';
      toolbar.innerHTML = '';
      return;
    }
    toolbar.style.display = 'flex';
    toolbar.innerHTML = exts.map(ext => `
      <button class="ext-toolbar-btn" data-ext-id="${ext.id}" title="${escapeHtml(ext.name)}">
        <img src="${escapeHtml(ext.icon)}" onerror="this.outerHTML='<i class=\\'ri-puzzle-line\\'></i>'" />
      </button>
    `).join('');
    toolbar.querySelectorAll('.ext-toolbar-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.electronAPI.openExtensionPopup(btn.dataset.extId);
      });
    });
  }

  async function handleLoadExtension() {
    if (!window.electronAPI?.loadExtension) return;
    const result = await window.electronAPI.loadExtension();
    if (result.ok) {
      UI.showToast(`"${result.extension.name}" 확장 프로그램이 추가되었습니다`, 'success');
      renderExtensionList();
      renderExtensionToolbar();
    } else if (result.error) {
      UI.showToast(result.error, 'error');
    }
  }

  // ═══════ Update History ═══════

  const GITHUB_RELEASES_URL = 'https://api.github.com/repos/handminjun504/linkflow/releases';

  async function fetchReleases() {
    try {
      const res = await fetch(GITHUB_RELEASES_URL, {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
      });
      if (!res.ok) throw new Error('API error');
      return await res.json();
    } catch {
      return null;
    }
  }

  function formatReleaseBody(body) {
    if (!body) return '';
    return body
      .replace(/\r\n/g, '\n')
      .replace(/^### (.+)$/gm, '<strong>$1</strong>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/gs, '<ul>$&</ul>')
      .replace(/\n{2,}/g, '<br/>');
  }

  async function showUpdateHistory() {
    UI.openModal('update-history-modal');
    const body = document.getElementById('update-history-body');
    body.innerHTML = '<div class="update-loading"><i class="ri-loader-4-line ri-spin"></i> 이력을 불러오는 중...</div>';

    const releases = await fetchReleases();
    if (!releases || !releases.length) {
      body.innerHTML = '<div class="update-release-empty"><i class="ri-history-line" style="font-size:32px;display:block;margin-bottom:8px"></i>업데이트 이력이 없습니다</div>';
      return;
    }

    body.innerHTML = releases.map((r, i) => {
      const date = new Date(r.published_at || r.created_at);
      const dateStr = `${date.getFullYear()}.${String(date.getMonth()+1).padStart(2,'0')}.${String(date.getDate()).padStart(2,'0')}`;
      const badge = i === 0 ? '<span class="update-release-badge latest">최신</span>' : '';
      const bodyHtml = r.body ? formatReleaseBody(r.body) : (r.name || '변경 사항 없음');
      return `
        <div class="update-release">
          <div class="update-release-header">
            <span class="update-release-version">${escapeHtml(r.tag_name || r.name)}</span>
            ${badge}
            <span class="update-release-date">${dateStr}</span>
          </div>
          <div class="update-release-body">${bodyHtml}</div>
        </div>`;
    }).join('');
  }

  window.__showUpdateHistory = showUpdateHistory;

  // ═══════ Quick Bookmark (Ctrl+D) ═══════
  window.__quickBookmark = () => {
    const tab = dynTabs.find(t => t.id === activeDynTabId);
    if (!tab) { openAddBookmark(); return; }
    document.getElementById('bookmark-modal-title').textContent = '빠른 북마크 추가';
    document.getElementById('bm-submit-btn').textContent = '추가';
    document.getElementById('bookmark-form').reset();
    document.getElementById('bm-edit-id').value = '';
    document.getElementById('bm-title').value = tab.title || '';
    document.getElementById('bm-url').value = tab.url || '';
    document.getElementById('bm-open-mode').value = 'auto';
    const sharedWrap = document.getElementById('bm-shared-wrap');
    if (Auth.isAdmin()) sharedWrap.classList.remove('hidden');
    else sharedWrap.classList.add('hidden');
    document.getElementById('bm-shared').checked = false;
    populateCategorySelect();
    UI.openModal('bookmark-modal');
  };

  // ═══════ Download Manager ═══════
  const downloadItems = [];
  window.__onDownload = (channel, data) => {
    if (channel === 'download-started') {
      downloadItems.push({ ...data, received: 0, state: 'progressing' });
      renderDownloadBar();
    } else if (channel === 'download-progress') {
      const item = downloadItems.find(d => d.id === data.id);
      if (item) { item.received = data.received; item.total = data.total; }
      renderDownloadBar();
    } else if (channel === 'download-done') {
      const item = downloadItems.find(d => d.id === data.id);
      if (item) { item.state = data.state; item.path = data.path; }
      renderDownloadBar();
    }
  };
  function renderDownloadBar() {
    let bar = document.getElementById('download-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'download-bar';
      bar.className = 'download-bar';
      document.body.appendChild(bar);
    }
    const active = downloadItems.filter(d => d.state === 'progressing' || d.state === 'completed');
    if (!active.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.innerHTML = active.slice(-3).map(d => {
      const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
      const name = d.filename.length > 25 ? d.filename.slice(0, 22) + '...' : d.filename;
      if (d.state === 'completed') {
        return `<div class="dl-item dl-done">
          <span class="dl-name">${name}</span>
          <button class="dl-action" onclick="window.electronAPI?.downloadOpen('${d.path?.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">열기</button>
          <button class="dl-action" onclick="window.electronAPI?.downloadShow('${d.path?.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">폴더</button>
        </div>`;
      }
      return `<div class="dl-item"><span class="dl-name">${name}</span><div class="dl-progress"><div class="dl-progress-fill" style="width:${pct}%"></div></div><span class="dl-pct">${pct}%</span></div>`;
    }).join('') + `<button class="dl-close" onclick="document.getElementById('download-bar').classList.add('hidden')">✕</button>`;
  }

  // ═══════ Command Palette (Ctrl+K) + Tab Search (Ctrl+Shift+A) ═══════
  const visitHistory = [];
  window.__commandPalette = (mode) => {
    let overlay = document.getElementById('cmd-palette');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'cmd-palette';
      overlay.className = 'cmd-palette-overlay';
      overlay.innerHTML = `<div class="cmd-palette"><input type="text" id="cmd-input" placeholder="탭, 북마크, 액션 검색..." autocomplete="off" /><div id="cmd-results" class="cmd-results"></div></div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) window.__closeCommandPalette(); });
      document.getElementById('cmd-input').addEventListener('input', () => renderPaletteResults());
      document.getElementById('cmd-input').addEventListener('keydown', (e) => {
        const items = document.querySelectorAll('.cmd-result-item');
        const active = document.querySelector('.cmd-result-item.active');
        let idx = [...items].indexOf(active);
        if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); items.forEach((it, i) => it.classList.toggle('active', i === idx)); items[idx]?.scrollIntoView({ block: 'nearest' }); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); items.forEach((it, i) => it.classList.toggle('active', i === idx)); items[idx]?.scrollIntoView({ block: 'nearest' }); }
        else if (e.key === 'Enter') { e.preventDefault(); if (active) active.click(); }
        else if (e.key === 'Escape') { window.__closeCommandPalette(); }
      });
    }
    overlay.classList.remove('hidden');
    const input = document.getElementById('cmd-input');
    input.value = '';
    input.placeholder = mode === 'tabs' ? '열린 탭 검색...' : '탭, 북마크, 액션 검색...';
    input.dataset.mode = mode || 'all';
    input.focus();
    renderPaletteResults();
  };
  window.__closeCommandPalette = () => {
    const overlay = document.getElementById('cmd-palette');
    if (overlay) overlay.classList.add('hidden');
  };
  function renderPaletteResults() {
    const input = document.getElementById('cmd-input');
    const results = document.getElementById('cmd-results');
    if (!input || !results) return;
    const q = input.value.toLowerCase();
    const mode = input.dataset.mode || 'all';
    const items = [];
    dynTabs.forEach(t => {
      if (!q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)) {
        items.push({ type: 'tab', icon: 'ri-window-line', label: t.title, sub: t.url, action: () => { switchToDynTab(t.id); window.__closeCommandPalette(); }});
      }
    });
    if (mode !== 'tabs') {
      bookmarks.forEach(b => {
        if (!q || b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)) {
          items.push({ type: 'bookmark', icon: 'ri-bookmark-line', label: b.title, sub: b.url, action: () => { openInBrowser(b); window.__closeCommandPalette(); }});
        }
      });
      const actions = [
        { label: '새 탭 열기', icon: 'ri-add-line', action: () => { createDynTab('https://www.google.com', 'Google'); window.__closeCommandPalette(); }},
        { label: '설정 열기', icon: 'ri-settings-3-line', action: () => { openSettings(); window.__closeCommandPalette(); }},
        { label: '화면 잠금', icon: 'ri-lock-line', action: () => { Auth.showLockScreen(); window.__closeCommandPalette(); }},
        { label: '화면 분할', icon: 'ri-layout-column-line', action: () => { window.__toggleSplit?.(); window.__closeCommandPalette(); }},
        { label: '스크린샷', icon: 'ri-screenshot-line', action: () => { window.__screenshot?.(); window.__closeCommandPalette(); }},
      ];
      actions.forEach(a => {
        if (!q || a.label.toLowerCase().includes(q)) items.push({ type: 'action', ...a });
      });
    }
    results.innerHTML = items.slice(0, 15).map((it, i) => `
      <div class="cmd-result-item ${i === 0 ? 'active' : ''}" data-idx="${i}">
        <i class="${it.icon} cmd-result-icon"></i>
        <div class="cmd-result-text"><div class="cmd-result-label">${escapeHtml(it.label)}</div>${it.sub ? `<div class="cmd-result-sub">${escapeHtml(it.sub.slice(0, 60))}</div>` : ''}</div>
        <span class="cmd-result-type">${it.type === 'tab' ? '탭' : it.type === 'bookmark' ? '북마크' : '액션'}</span>
      </div>
    `).join('') || '<div class="cmd-result-empty">결과 없음</div>';
    results.querySelectorAll('.cmd-result-item').forEach((el, i) => {
      el.addEventListener('click', () => items[i]?.action());
      el.addEventListener('mouseenter', () => {
        results.querySelectorAll('.cmd-result-item').forEach(it => it.classList.remove('active'));
        el.classList.add('active');
      });
    });
  }

  // ═══════ Split View (Ctrl+\) ═══════
  window.__toggleSplit = () => {
    const framesContainer = document.getElementById('dynamic-tab-frames');
    const wrap = framesContainer?.querySelector('.dtf-frame-wrap');
    if (!wrap) return;
    if (splitMode) {
      splitMode = null;
      wrap.classList.remove('split-active');
      wrap.style.gridTemplateColumns = '';
      wrap.querySelectorAll('webview, iframe').forEach(f => {
        f.classList.remove('split-left', 'split-right');
        if (f.dataset.dynId !== String(activeDynTabId)) f.classList.remove('active');
      });
      const resizer = wrap.querySelector('.split-resizer');
      if (resizer) {
        if (resizer._cleanup) resizer._cleanup();
        resizer.remove();
      }
    } else {
      if (dynTabs.length < 2) { UI.showToast('분할하려면 탭이 2개 이상 필요합니다', 'info'); return; }
      const leftId = activeDynTabId;
      const otherTab = dynTabs.find(t => t.id !== leftId);
      if (!otherTab) return;
      splitMode = { leftId, rightId: otherTab.id };
      wrap.classList.add('split-active');
      const sel = isElectron ? 'webview' : 'iframe';
      wrap.querySelectorAll(sel).forEach(f => {
        const fid = parseInt(f.dataset.dynId, 10);
        f.classList.remove('active', 'split-left', 'split-right');
        if (fid === leftId) { f.classList.add('active', 'split-left'); }
        else if (fid === otherTab.id) { f.classList.add('active', 'split-right'); }
      });
      const resizer = document.createElement('div');
      resizer.className = 'split-resizer';
      wrap.appendChild(resizer);
      let dragging = false;
      const onMove = (e) => {
        if (!dragging) return;
        const rect = wrap.getBoundingClientRect();
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        wrap.style.gridTemplateColumns = `${Math.max(20, Math.min(80, pct))}% 4px 1fr`;
      };
      const onUp = () => { dragging = false; };
      resizer.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      resizer._cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
    }
  };

  // ═══════ Tab Hibernation ═══════
  function startHibernation() {
    if (hibernateTimerId) clearInterval(hibernateTimerId);
    hibernateTimerId = setInterval(() => {
      const timeout = 5 * 60 * 1000;
      const now = Date.now();
      dynTabs.forEach(t => {
        if (t.id === activeDynTabId || t.hibernated) return;
        if (now - t.lastActive > timeout) {
          const sel = isElectron ? 'webview' : 'iframe';
          const frame = document.querySelector(`#dynamic-tab-frames ${sel}[data-dyn-id="${t.id}"]`);
          if (frame) {
            frame.src = 'about:blank';
            t.hibernated = true;
            const tabEl = document.querySelector(`.dyn-tab[data-dyn-id="${t.id}"]`);
            if (tabEl) tabEl.classList.add('hibernated');
          }
        }
      });
    }, 60000);
  }

  // ═══════ Screenshot (Ctrl+Shift+S) ═══════
  window.__screenshot = async () => {
    if (!window.electronAPI?.captureWebview) return;
    try {
      const dataUrl = await window.electronAPI.captureWebview();
      if (!dataUrl) { UI.showToast('캡처 실패', 'error'); return; }
      let overlay = document.getElementById('screenshot-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'screenshot-overlay';
        overlay.className = 'screenshot-overlay';
        overlay.innerHTML = `<div class="ss-container"><img id="ss-preview" /><div class="ss-actions"><button class="ss-btn" id="ss-copy"><i class="ri-clipboard-line"></i> 복사</button><button class="ss-btn" id="ss-save"><i class="ri-download-line"></i> 저장</button><button class="ss-btn ss-close" id="ss-close"><i class="ri-close-line"></i> 닫기</button></div></div>`;
        document.body.appendChild(overlay);
        document.getElementById('ss-close').addEventListener('click', () => overlay.classList.add('hidden'));
        document.getElementById('ss-copy').addEventListener('click', async () => {
          try {
            const img = document.getElementById('ss-preview');
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            canvas.toBlob(blob => { navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); });
            UI.showToast('클립보드에 복사되었습니다', 'success');
          } catch { UI.showToast('복사 실패', 'error'); }
        });
        document.getElementById('ss-save').addEventListener('click', () => {
          const a = document.createElement('a');
          a.href = document.getElementById('ss-preview').src;
          a.download = `screenshot_${Date.now()}.png`;
          a.click();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
      }
      document.getElementById('ss-preview').src = dataUrl;
      overlay.classList.remove('hidden');
    } catch { UI.showToast('캡처 실패', 'error'); }
  };

  // ═══════ URL Notes ═══════
  function showUrlNotePopover() {
    const tab = dynTabs.find(t => t.id === activeDynTabId);
    if (!tab) return;
    let host; try { host = new URL(tab.url).hostname; } catch { return; }
    let pop = document.getElementById('url-note-popover');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'url-note-popover';
      pop.className = 'url-note-popover';
      pop.innerHTML = `<textarea id="url-note-text" placeholder="이 사이트에 메모를 남겨보세요..."></textarea><div class="url-note-actions"><button id="url-note-save" class="url-note-btn">저장</button><button id="url-note-del" class="url-note-btn danger">삭제</button></div>`;
      document.body.appendChild(pop);
      document.getElementById('url-note-save').addEventListener('click', () => {
        const val = document.getElementById('url-note-text').value.trim();
        const h = pop.dataset.host;
        if (val) urlNotes[h] = val;
        else delete urlNotes[h];
        localStorage.setItem('lf_url_notes', JSON.stringify(urlNotes));
        pop.classList.add('hidden');
        const noteBtn = document.getElementById('dtf-note-btn');
        if (noteBtn) noteBtn.classList.toggle('has-note', !!val);
        UI.showToast(val ? '메모 저장됨' : '메모 삭제됨', 'success');
      });
      document.getElementById('url-note-del').addEventListener('click', () => {
        const h = pop.dataset.host;
        delete urlNotes[h];
        localStorage.setItem('lf_url_notes', JSON.stringify(urlNotes));
        document.getElementById('url-note-text').value = '';
        pop.classList.add('hidden');
        const noteBtn = document.getElementById('dtf-note-btn');
        if (noteBtn) noteBtn.classList.remove('has-note');
      });
    }
    pop.dataset.host = host;
    document.getElementById('url-note-text').value = urlNotes[host] || '';
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) document.getElementById('url-note-text').focus();
  }

  // ═══════ Picture-in-Picture ═══════
  window.__pip = async () => {
    if (!window.electronAPI?.pipCreate) return;
    const tab = dynTabs.find(t => t.id === activeDynTabId);
    if (!tab) return;
    const partition = tab.containerId ? `persist:container_${tab.containerId}` : 'persist:main';
    await window.electronAPI.pipCreate({ url: tab.url, partition });
  };

  // ═══════ Browser View (Dynamic Tabs) ═══════

  const isElectron = /electron/i.test(navigator.userAgent);
  const closedTabHistory = [];

  // ── Chrome-like Global Shortcuts ──
  window.__newTab = () => createDynTab('https://www.google.com', 'Google');
  window.__closeActiveTab = () => { if (activeDynTabId != null) closeDynTab(activeDynTabId); };
  window.__reopenClosedTab = () => {
    const last = closedTabHistory.pop();
    if (last) createDynTab(last.url, last.title);
  };
  window.__nextTab = () => {
    if (!dynTabs.length) return;
    if (activeDynTabId == null) { switchToDynTab(dynTabs[0].id); return; }
    const idx = dynTabs.findIndex(t => t.id === activeDynTabId);
    const next = dynTabs[(idx + 1) % dynTabs.length];
    if (next) switchToDynTab(next.id);
  };
  window.__prevTab = () => {
    if (!dynTabs.length) return;
    if (activeDynTabId == null) { switchToDynTab(dynTabs[dynTabs.length - 1].id); return; }
    const idx = dynTabs.findIndex(t => t.id === activeDynTabId);
    const prev = dynTabs[(idx - 1 + dynTabs.length) % dynTabs.length];
    if (prev) switchToDynTab(prev.id);
  };
  window.__focusUrlBar = () => {
    const input = document.getElementById('dtf-url-input');
    if (input) { input.focus(); input.select(); }
  };
  window.__switchToTabIndex = (i) => {
    if (i >= dynTabs.length) {
      if (dynTabs.length) switchToDynTab(dynTabs[dynTabs.length - 1].id);
      return;
    }
    switchToDynTab(dynTabs[i].id);
  };
  window.__findInPage = () => {
    const frame = getActiveFrame();
    if (!frame || frame.tagName !== 'WEBVIEW') return;
    let bar = document.getElementById('find-bar');
    if (!bar) {
      const framesContainer = document.getElementById('dynamic-tab-frames');
      bar = document.createElement('div');
      bar.id = 'find-bar';
      bar.className = 'find-bar';
      bar.innerHTML = `
        <input type="text" id="find-bar-input" placeholder="페이지에서 찾기..." autocomplete="off" />
        <span id="find-bar-count" class="find-bar-count"></span>
        <button class="find-bar-btn" id="find-bar-prev" title="이전 (Shift+Enter)"><i class="ri-arrow-up-s-line"></i></button>
        <button class="find-bar-btn" id="find-bar-next" title="다음 (Enter)"><i class="ri-arrow-down-s-line"></i></button>
        <button class="find-bar-btn" id="find-bar-close" title="닫기 (Esc)"><i class="ri-close-line"></i></button>
      `;
      const toolbar = framesContainer.querySelector('.dtf-toolbar');
      if (toolbar) toolbar.after(bar);
      else framesContainer.prepend(bar);

      const findInput = document.getElementById('find-bar-input');
      findInput.addEventListener('input', (ev) => {
        const f = getActiveFrame();
        if (!f || f.tagName !== 'WEBVIEW') return;
        const q = ev.target.value;
        if (q) f.findInPage(q);
        else { f.stopFindInPage('clearSelection'); document.getElementById('find-bar-count').textContent = ''; }
      });
      findInput.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const f = getActiveFrame();
          const q = findInput.value;
          if (f && f.tagName === 'WEBVIEW' && q) f.findInPage(q, { forward: !ev.shiftKey, findNext: true });
        } else if (ev.key === 'Escape') {
          window.__closeFindBar();
        }
      });
      findInput.addEventListener('focus', () => { findInput.dataset.focused = '1'; });
      findInput.addEventListener('blur', () => { delete findInput.dataset.focused; });
      document.getElementById('find-bar-next').addEventListener('click', () => {
        const f = getActiveFrame();
        const q = findInput.value;
        if (f && q) f.findInPage(q, { forward: true, findNext: true });
        findInput.focus();
      });
      document.getElementById('find-bar-prev').addEventListener('click', () => {
        const f = getActiveFrame();
        const q = findInput.value;
        if (f && q) f.findInPage(q, { forward: false, findNext: true });
        findInput.focus();
      });
      document.getElementById('find-bar-close').addEventListener('click', () => window.__closeFindBar());
    }
    bar.classList.remove('hidden');
    const input = document.getElementById('find-bar-input');
    setTimeout(() => { input.focus(); input.select(); }, 50);
  };
  window.__closeFindBar = () => {
    const bar = document.getElementById('find-bar');
    if (bar) bar.classList.add('hidden');
    const frame = getActiveFrame();
    if (frame && frame.tagName === 'WEBVIEW') frame.stopFindInPage('clearSelection');
    const countEl = document.getElementById('find-bar-count');
    if (countEl) countEl.textContent = '';
  };

  function showTabContextMenu(tabId, x, y) {
    let menu = document.getElementById('tab-context-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'tab-context-menu';
      menu.className = 'tab-context-menu';
      document.body.appendChild(menu);
    }
    const tab = dynTabs.find(t => t.id === tabId);
    if (!tab) return;
    menu.innerHTML = `
      <div class="tcm-item" data-action="reload"><i class="ri-refresh-line"></i> 새로고침</div>
      <div class="tcm-item" data-action="duplicate"><i class="ri-file-copy-line"></i> 탭 복제</div>
      <div class="tcm-item" data-action="pin"><i class="ri-pushpin-line"></i> 탭 고정</div>
      <div class="tcm-divider"></div>
      <div class="tcm-item" data-action="close"><i class="ri-close-line"></i> 탭 닫기</div>
      <div class="tcm-item" data-action="close-others"><i class="ri-close-circle-line"></i> 다른 탭 모두 닫기</div>
      <div class="tcm-item" data-action="close-right"><i class="ri-skip-right-line"></i> 오른쪽 탭 모두 닫기</div>
    `;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.remove('hidden');

    const handler = (e) => {
      const item = e.target.closest('.tcm-item');
      if (item) {
        const action = item.dataset.action;
        if (action === 'reload') {
          const sel = isElectron ? 'webview' : 'iframe';
          const frame = document.querySelector(`#dynamic-tab-frames ${sel}[data-dyn-id="${tabId}"]`);
          if (frame?.reload) frame.reload();
          else if (frame) frame.src = frame.src;
        } else if (action === 'duplicate') {
          createDynTab(tab.url, tab.title);
        } else if (action === 'close') {
          closeDynTab(tabId);
        } else if (action === 'close-others') {
          dynTabs.filter(t => t.id !== tabId).forEach(t => closeDynTab(t.id));
        } else if (action === 'close-right') {
          const idx = dynTabs.findIndex(t => t.id === tabId);
          dynTabs.slice(idx + 1).forEach(t => closeDynTab(t.id));
        }
      }
      menu.classList.add('hidden');
      document.removeEventListener('click', handler, true);
      document.removeEventListener('contextmenu', dismissHandler, true);
    };
    const dismissHandler = (e) => {
      if (!menu.contains(e.target)) {
        menu.classList.add('hidden');
        document.removeEventListener('click', handler, true);
        document.removeEventListener('contextmenu', dismissHandler, true);
        e.preventDefault();
      }
    };
    setTimeout(() => {
      document.addEventListener('click', handler, true);
      document.addEventListener('contextmenu', dismissHandler, true);
    }, 0);
  }

  async function openInBrowser(bm) {
    const url = bm.url;

    if (isElectron) {
      createDynTab(url, bm.title);
      return;
    }

    const mode = bm.open_mode || 'auto';

    if (mode === 'external') {
      window.open(url, '_blank');
      return;
    }

    if (mode === 'auto') {
      try {
        const result = await Auth.request(`/check-embeddable?url=${encodeURIComponent(url)}`);
        if (!result.embeddable) {
          window.open(url, '_blank');
          return;
        }
      } catch {
        window.open(url, '_blank');
        return;
      }
    }

    createDynTab(url, bm.title);
  }

  function handleUnlock() {
    const input = document.getElementById('lock-pin-input');
    if (Auth.tryUnlock(input.value)) {
      document.getElementById('lock-screen').classList.add('hidden');
      document.getElementById('lock-error').classList.add('hidden');
      input.value = '';
      Auth.resetActivity();
    } else {
      document.getElementById('lock-error').textContent = 'PIN이 올바르지 않습니다';
      document.getElementById('lock-error').classList.remove('hidden');
      input.value = '';
      input.focus();
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-error');
    errEl.classList.add('hidden');
    UI.setLoading(btn, true);
    try {
      await Auth.login(
        document.getElementById('login-username').value.trim(),
        document.getElementById('login-password').value,
        document.getElementById('login-remember').checked,
      );
      showDashboard();
    } catch (err) {
      errEl.textContent = err.message === 'Invalid credentials' ? '아이디 또는 비밀번호가 올바르지 않습니다' : err.message;
      errEl.classList.remove('hidden');
    } finally { UI.setLoading(btn, false); }
  }

  async function handleSetup(e) {
    e.preventDefault();
    try {
      await Auth.request('/setup', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('setup-username').value.trim(),
          password: document.getElementById('setup-password').value,
          display_name: document.getElementById('setup-display').value.trim(),
        }),
      });
      UI.showToast('관리자 계정이 생성되었습니다. 로그인 해주세요.', 'success');
      document.getElementById('setup-section').classList.add('hidden');
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  // ═══════ Event Bindings ═══════

  document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'f' && activeDynTabId != null) {
        e.preventDefault();
        window.__findInPage && window.__findInPage();
      }
      if (e.key === 'Escape') {
        window.__closeFindBar && window.__closeFindBar();
      }
    });

    // Tab navigation
    document.querySelectorAll('.main-tab[data-tab]').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Forms
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('setup-form').addEventListener('submit', handleSetup);
    document.getElementById('bookmark-form').addEventListener('submit', saveBookmark);
    document.getElementById('category-form').addEventListener('submit', saveCategory);
    document.getElementById('user-form').addEventListener('submit', createUser);
    document.getElementById('pw-form').addEventListener('submit', changePassword);

    // Header buttons
    document.getElementById('btn-add-bookmark').addEventListener('click', openAddBookmark);
    document.getElementById('btn-empty-add')?.addEventListener('click', openAddBookmark);
    document.getElementById('btn-settings').addEventListener('click', openSettings);
    document.getElementById('btn-admin').addEventListener('click', openAdmin);
    document.getElementById('btn-clients').addEventListener('click', openClientsPanel);

    // Panels
    document.getElementById('close-settings').addEventListener('click', () => UI.hidePanel('settings-panel'));
    document.getElementById('close-admin').addEventListener('click', () => UI.hidePanel('admin-panel'));
    document.getElementById('close-clients').addEventListener('click', () => UI.hidePanel('clients-panel'));
    document.getElementById('close-client-detail').addEventListener('click', () => UI.hidePanel('client-detail-panel'));
    document.getElementById('btn-client-back').addEventListener('click', () => {
      UI.hidePanel('client-detail-panel');
      UI.showPanel('clients-panel');
    });
    document.getElementById('panel-overlay').addEventListener('click', UI.hideAllPanels);

    // Settings
    document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
    document.getElementById('btn-save-lock').addEventListener('click', saveLockSettings);
    document.getElementById('btn-add-category').addEventListener('click', openAddCategory);
    document.getElementById('btn-create-user').addEventListener('click', () => {
      if (adminTeams.length) populateTeamSelect('new-user-team', adminTeams);
      UI.openModal('user-modal');
    });
    document.getElementById('btn-create-team').addEventListener('click', createTeam);

    // Clients tab
    document.getElementById('btn-tab-add-client').addEventListener('click', openAddClient);
    document.getElementById('clients-search-input').addEventListener('input', (e) => {
      clientsTabSearchQuery = e.target.value.trim();
      renderClientsTabList();
    });

    // Clients side panel
    document.getElementById('btn-add-client').addEventListener('click', openAddClient);
    document.getElementById('client-form').addEventListener('submit', saveClient);
    document.getElementById('btn-edit-client').addEventListener('click', openEditClient);
    document.getElementById('btn-delete-client').addEventListener('click', deleteClient);
    document.getElementById('btn-add-shortcut').addEventListener('click', openAddShortcut);
    document.getElementById('shortcut-form').addEventListener('submit', saveShortcut);

    document.querySelectorAll('.btn-copy-cred').forEach(btn => {
      btn.addEventListener('click', () => {
        const el = document.getElementById(btn.dataset.target);
        const text = el._realValue || el.textContent;
        navigator.clipboard.writeText(text).then(() => UI.showToast('복사되었습니다', 'success'));
      });
    });
    document.querySelectorAll('.btn-toggle-pw').forEach(btn => {
      btn.addEventListener('click', () => {
        const el = document.getElementById(btn.dataset.target);
        if (el.classList.contains('cred-masked')) {
          el.textContent = el._realValue || '';
          el.classList.remove('cred-masked');
          btn.querySelector('i').className = 'ri-eye-off-line';
        } else {
          el.textContent = '••••••';
          el.classList.add('cred-masked');
          btn.querySelector('i').className = 'ri-eye-line';
        }
      });
    });
    document.getElementById('btn-change-pw').addEventListener('click', () => {
      document.getElementById('user-dropdown').classList.add('hidden');
      document.getElementById('pw-form').reset();
      UI.openModal('pw-modal');
    });
    document.getElementById('btn-logout').addEventListener('click', () => {
      document.getElementById('user-dropdown').classList.add('hidden');
      Auth.logout();
    });

    // User dropdown
    document.getElementById('user-badge').addEventListener('click', () => {
      document.getElementById('user-dropdown').classList.toggle('hidden');
    });
    document.addEventListener('click', e => {
      const badge = document.getElementById('user-badge');
      const dropdown = document.getElementById('user-dropdown');
      if (!badge.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.add('hidden');
    });

    // Modal close
    document.querySelectorAll('.modal-close, [data-modal]').forEach(btn => {
      btn.addEventListener('click', () => { if (btn.dataset.modal) UI.closeModal(btn.dataset.modal); });
    });

    // Dynamic Tab: + button
    document.getElementById('btn-add-tab').addEventListener('click', () => {
      createDynTab('https://www.google.com', 'Google');
    });

    if (isElectron) {
      window.__electronOpenTab = (url) => createDynTab(url);
    }

    // Password save bar
    const pwSaveYes = document.getElementById('pw-save-yes');
    const pwSaveNo = document.getElementById('pw-save-no');
    if (pwSaveYes) pwSaveYes.addEventListener('click', handlePwSave);
    if (pwSaveNo) pwSaveNo.addEventListener('click', hidePwSaveBar);

    // Extension: load button
    const extLoadBtn = document.getElementById('btn-load-extension');
    if (extLoadBtn) extLoadBtn.addEventListener('click', handleLoadExtension);

    // Update history button
    const updateHistoryBtn = document.getElementById('btn-update-history');
    if (updateHistoryBtn) updateHistoryBtn.addEventListener('click', showUpdateHistory);

    // Responsive zoom + Ctrl+Wheel manual zoom
    const BASE_WIDTH = 1280;
    const MIN_ZOOM = 0.4;
    const MAX_ZOOM = 2.0;
    let manualZoom = null;
    function autoZoom() {
      return Math.min(1, Math.max(MIN_ZOOM, window.innerWidth / BASE_WIDTH));
    }
    function setZoom(z) {
      z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
      manualZoom = z;
      if (activeDynTabId == null) document.body.style.zoom = z;
    }
    function applyZoom() {
      if (activeDynTabId != null) {
        document.body.style.zoom = 1;
      } else {
        document.body.style.zoom = manualZoom ?? autoZoom();
      }
    }
    applyZoom();
    window.addEventListener('resize', () => { if (!manualZoom) applyZoom(); });
    window.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      if (activeDynTabId != null) return;
      e.preventDefault();
      const current = manualZoom ?? autoZoom();
      const step = 0.05;
      setZoom(current + (e.deltaY < 0 ? step : -step));
    }, { passive: false });

    // Search
    document.getElementById('search-input').addEventListener('input', renderBookmarks);

    // Lock
    document.getElementById('lock-pin-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleUnlock(); });

    // Setup toggle (5 clicks on logo)
    const loginLogo = document.querySelector('.login-logo');
    if (loginLogo) {
      let clickCount = 0;
      loginLogo.addEventListener('click', () => {
        clickCount++;
        if (clickCount >= 5) { document.getElementById('setup-section').classList.remove('hidden'); clickCount = 0; }
      });
    }

    init();
  });

  setInterval(() => {
    if (Auth.isLoggedIn() && document.getElementById('lock-screen').classList.contains('hidden')) {
      if (activeTab === 'bookmarks') checkHealthAll();
    }
  }, 60000);
})();
