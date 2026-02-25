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

    if (tab === 'calendar') Calendar.load();
    if (tab === 'memos') Memos.load();
  }

  function switchToDynTab(id) {
    activeDynTabId = id;
    activeTab = '__dyn__';

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
      const urlBar = framesContainer.querySelector('.dtf-url-bar');
      if (urlBar) urlBar.textContent = tab.url;
    }
  }

  function updateTabDivider() {
    const divider = document.getElementById('tab-divider');
    if (divider) divider.classList.toggle('visible', dynTabs.length > 0);
  }

  function createDynTab(url, title) {
    const id = ++dynTabIdCounter;
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch {}
    const tab = { id, url, title: title || hostname || url };
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

    const closeBtn = document.createElement('span');
    closeBtn.className = 'dyn-tab-close';
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDynTab(id);
    });

    el.appendChild(favicon);
    el.appendChild(titleSpan);
    el.appendChild(closeBtn);
    el.addEventListener('click', () => switchToDynTab(id));
    container.appendChild(el);
    updateTabDivider();

    const framesContainer = document.getElementById('dynamic-tab-frames');

    if (!framesContainer.querySelector('.dtf-toolbar')) {
      framesContainer.innerHTML = `
        <div class="dtf-toolbar">
          <button class="dtf-btn" id="dtf-back" title="뒤로"><i class="ri-arrow-left-line"></i></button>
          <button class="dtf-btn" id="dtf-forward" title="앞으로"><i class="ri-arrow-right-line"></i></button>
          <button class="dtf-btn" id="dtf-refresh" title="새로고침"><i class="ri-refresh-line"></i></button>
          <div class="dtf-url-bar"></div>
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
    }

    const frameWrap = framesContainer.querySelector('.dtf-frame-wrap');
    let frame;

    if (isElectron) {
      frame = document.createElement('webview');
      frame.dataset.dynId = id;
      frame.setAttribute('allowpopups', '');
      frame.setAttribute('partition', 'persist:main');
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
          const bar = framesContainer.querySelector('.dtf-url-bar');
          if (bar) bar.textContent = e.url;
        }
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

  function closeDynTab(id) {
    const idx = dynTabs.findIndex(t => t.id === id);
    if (idx === -1) return;
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

    const adminBtn = document.getElementById('btn-admin');
    if (Auth.isAdmin()) adminBtn.style.display = '';
    else adminBtn.style.display = 'none';

    Calendar.init();
    Memos.init();
    loadData();
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

    let html = filtered.map(b => cardHTML(b, false)).join('');

    if (sharedFiltered.length > 0 && activeCategory === 'all') {
      html += `<div class="shared-section-title">공용 북마크</div>`;
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

    const iconContent = b.icon_url
      ? `<img src="${b.icon_url}" alt="" onerror="this.style.display='none';this.parentNode.innerHTML='<i class=\\'${typeInfo.icon}\\'></i>'" />`
      : `<i class="${typeInfo.icon}"></i>`;

    const catName = b.categories?.name ? `${b.categories.icon || ''} ${b.categories.name}` : '';

    return `
      <div class="bookmark-card" data-id="${b.id}" draggable="${isShared ? 'false' : 'true'}">
        ${isShared ? '<span class="bookmark-shared-badge">공용</span>' : ''}
        ${!isShared ? `<div class="bookmark-actions">
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

  async function openAdmin() {
    UI.showPanel('admin-panel');
    try {
      const users = await Auth.request('/admin/users');
      renderAdminUsers(users);
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  function renderAdminUsers(users) {
    const list = document.getElementById('admin-user-list');
    list.innerHTML = users.map(u => `
      <div class="user-item">
        <div class="user-item-avatar">${(u.display_name || u.username).charAt(0).toUpperCase()}</div>
        <div class="user-item-info">
          <div class="user-name">${escapeHtml(u.display_name)}${u.is_admin ? '<span class="admin-badge">관리자</span>' : ''}</div>
          <div class="user-id">${escapeHtml(u.username)}</div>
        </div>
        <div class="user-item-actions">
          ${!u.is_admin ? `
            <button class="icon-btn btn-reset-pw" data-id="${u.id}" data-name="${escapeHtml(u.display_name)}" title="비밀번호 초기화"><i class="ri-key-line"></i></button>
            <button class="icon-btn btn-delete-user" data-id="${u.id}" data-name="${escapeHtml(u.display_name)}" title="삭제"><i class="ri-delete-bin-line"></i></button>
          ` : ''}
        </div>
      </div>`).join('');

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
    const data = {
      username: document.getElementById('new-user-id').value.trim(),
      password: document.getElementById('new-user-pw').value,
      display_name: document.getElementById('new-user-name').value.trim(),
    };
    try {
      await Auth.request('/admin/users', { method: 'POST', body: JSON.stringify(data) });
      UI.showToast(`${data.display_name} 사용자가 생성되었습니다`, 'success');
      UI.closeModal('user-modal');
      document.getElementById('user-form').reset();
      openAdmin();
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

  // ═══════ Browser View (Dynamic Tabs) ═══════

  const isElectron = /electron/i.test(navigator.userAgent);

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

    // Panels
    document.getElementById('close-settings').addEventListener('click', () => UI.hidePanel('settings-panel'));
    document.getElementById('close-admin').addEventListener('click', () => UI.hidePanel('admin-panel'));
    document.getElementById('panel-overlay').addEventListener('click', UI.hideAllPanels);

    // Settings
    document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
    document.getElementById('btn-save-lock').addEventListener('click', saveLockSettings);
    document.getElementById('btn-add-category').addEventListener('click', openAddCategory);
    document.getElementById('btn-create-user').addEventListener('click', () => UI.openModal('user-modal'));
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
