const Calendar = (() => {
  let currentYear, currentMonth;
  let events = [];
  let notifyEvents = [];
  let weekTasks = [];
  let notifyTimers = [];
  let holidayCache = {};

  const DAY_COLORS = [
    { cls: 'task-day-sun', label: '일' },
    { cls: 'task-day-mon', label: '월' },
    { cls: 'task-day-tue', label: '화' },
    { cls: 'task-day-wed', label: '수' },
    { cls: 'task-day-thu', label: '목' },
    { cls: 'task-day-fri', label: '금' },
    { cls: 'task-day-sat', label: '토' },
  ];

  function init() {
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth();

    document.getElementById('cal-prev').addEventListener('click', () => navigate(-1));
    document.getElementById('cal-next').addEventListener('click', () => navigate(1));
    document.getElementById('cal-today').addEventListener('click', goToday);
    document.getElementById('event-form').addEventListener('submit', saveEvent);
    document.getElementById('evt-delete-btn').addEventListener('click', deleteCurrentEvent);

    document.getElementById('evt-color-picker').querySelectorAll('.color-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        document.getElementById('evt-color-picker').querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        document.getElementById('evt-color').value = dot.dataset.color;
      });
    });

    document.getElementById('evt-recurrence').addEventListener('change', e => {
      const val = e.target.value;
      const hasRecurrence = !!val;
      const isMonthly = val === 'monthly';
      document.getElementById('evt-recurrence-end-wrap').style.display = hasRecurrence ? '' : 'none';
      document.getElementById('evt-skip-weekend-wrap').style.display = hasRecurrence ? '' : 'none';
      document.getElementById('evt-recurrence-day-wrap').style.display = isMonthly ? '' : 'none';
    });

    requestNotificationPermission();
    loadClientOptions();
  }

  async function loadHolidays(year) {
    if (holidayCache[year]) return holidayCache[year];
    try {
      const res = await fetch(`/api/holidays?year=${year}`);
      const data = await res.json();
      const map = {};
      data.forEach(h => { map[h.date] = h.name; });
      holidayCache[year] = map;
      return map;
    } catch {
      return {};
    }
  }

  function navigate(dir) {
    currentMonth += dir;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    load();
  }

  function goToday() {
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth();
    load();
  }

  async function load(retryCount = 0) {
    document.getElementById('cal-month-title').textContent =
      `${currentYear}년 ${currentMonth + 1}월`;

    if (!Auth.isLoggedIn()) {
      events = [];
      render();
      return;
    }

    const now = new Date();
    const realYear = now.getFullYear();
    const realMonth = now.getMonth() + 1;
    const isViewingCurrentMonth = currentYear === realYear && (currentMonth + 1) === realMonth;

    try {
      const promises = [
        Auth.request(`/events?year=${currentYear}&month=${currentMonth + 1}`),
        loadHolidays(currentYear),
      ];
      if (!isViewingCurrentMonth) {
        promises.push(Auth.request(`/events?year=${realYear}&month=${realMonth}`));
      }
      const results = await Promise.all(promises);
      events = results[0];
      notifyEvents = isViewingCurrentMonth ? events : (results[2] || []);
    } catch (err) {
      console.error('[Calendar] 일정 로드 실패:', err.message);
      if (err.message !== 'Session expired' && retryCount < 1) {
        return load(retryCount + 1);
      }
      if (err.message !== 'Session expired' && typeof UI !== 'undefined') {
        UI.showToast('일정을 불러오지 못했습니다', 'error');
      }
      events = [];
      notifyEvents = [];
    }
    render();
    scheduleNotifications();
    loadWeekTasks();
  }

  function render() {
    const grid = document.getElementById('calendar-grid');
    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === currentYear && today.getMonth() === currentMonth;
    const holidays = holidayCache[currentYear] || {};

    let html = '';

    for (let i = 0; i < firstDay; i++) {
      html += '<div class="cal-cell empty"></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayEvents = events.filter(e => e.start_date === dateStr);
      const isToday = isCurrentMonth && today.getDate() === d;
      const dow = (firstDay + d - 1) % 7;
      const isSun = dow === 0;
      const isSat = dow === 6;
      const holidayName = holidays[dateStr];
      const isHoliday = !!holidayName;

      let cellClass = 'cal-cell';
      if (isToday) cellClass += ' today';
      if (isSun) cellClass += ' sun';
      if (isSat) cellClass += ' sat';
      if (isHoliday) cellClass += ' holiday';

      html += `<div class="${cellClass}" data-date="${dateStr}">`;
      html += `<span class="cal-day-num">${d}</span>`;
      if (isHoliday) {
        html += `<div class="cal-holiday-name">${escapeHtml(holidayName)}</div>`;
      }
      if (dayEvents.length > 0) {
        html += '<div class="cal-events">';
        dayEvents.slice(0, 3).forEach(ev => {
          const time = ev.start_time ? ev.start_time.substring(0, 5) + ' ' : '';
          const recurIcon = ev._recurring || ev.recurrence_type ? '<i class="ri-repeat-line" style="font-size:9px;margin-right:2px"></i>' : '';
          const taskIcon = ev.is_task ? '<i class="ri-checkbox-circle-line" style="font-size:9px;margin-right:2px"></i>' : '';
          const clientName = getClientName(ev.client_id);
          const clientTag = clientName ? `<span class="cal-client-tag">${escapeHtml(clientName)}</span> ` : '';
          const doneClass = ev.is_done ? ' cal-event-done' : '';
          html += `<div class="cal-event-bar${doneClass}" style="background:${ev.color}" data-id="${ev.id}" title="${time}${clientName ? '['+clientName+'] ' : ''}${ev.title}">${recurIcon}${taskIcon}${clientTag}${time}${escapeHtml(ev.title)}</div>`;
        });
        if (dayEvents.length > 3) {
          html += `<div class="cal-event-more">+${dayEvents.length - 3}</div>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }

    grid.innerHTML = html;

    grid.querySelectorAll('.cal-cell:not(.empty)').forEach(cell => {
      cell.addEventListener('click', e => {
        if (e.target.closest('.cal-event-bar')) {
          const evtId = e.target.closest('.cal-event-bar').dataset.id;
          openEditEvent(evtId);
        } else {
          openAddEvent(cell.dataset.date);
        }
      });
    });
  }

  // ── Task Sidebar ──

  async function loadWeekTasks() {
    if (!Auth.isLoggedIn()) { weekTasks = []; renderTaskSidebar(); return; }
    try {
      const today = new Date().toISOString().split('T')[0];
      weekTasks = await Auth.request(`/events/week?date_str=${today}`);
    } catch (err) {
      console.error('[Calendar] 주간 작업 로드 실패:', err.message);
      weekTasks = [];
    }
    renderTaskSidebar();
  }

  function renderTaskSidebar() {
    const container = document.getElementById('task-list');
    if (weekTasks.length === 0) {
      container.innerHTML = '<div class="task-empty"><i class="ri-checkbox-circle-line"></i><p>이번 주 업무가 없습니다</p></div>';
      return;
    }

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const grouped = {};
    weekTasks.forEach(t => {
      const d = t.start_date;
      if (!grouped[d]) grouped[d] = [];
      grouped[d].push(t);
    });

    let html = '';
    Object.keys(grouped).sort().forEach(dateKey => {
      const dt = new Date(dateKey + 'T00:00:00');
      const dow = dt.getDay();
      const dayInfo = DAY_COLORS[dow];
      const isToday = dateKey === todayStr;
      const dayLabel = `${dt.getMonth() + 1}/${dt.getDate()} (${dayInfo.label})`;

      html += `<div class="task-day-group ${dayInfo.cls}${isToday ? ' task-day-today' : ''}">`;
      html += `<div class="task-day-label">${dayLabel}${isToday ? ' <span class="task-today-badge">오늘</span>' : ''}</div>`;

      grouped[dateKey].forEach(t => {
        const checked = t.is_done ? 'checked' : '';
        const doneClass = t.is_done ? ' task-done' : '';
        const time = t.start_time ? t.start_time.substring(0, 5) : '';
        const dateAttr = (t._recurring || t.recurrence_type) ? ` data-date="${t.start_date}"` : '';
        html += `<div class="task-item${doneClass}">
          <input type="checkbox" class="task-check" data-id="${t.id}"${dateAttr} ${checked} />
          <div class="task-item-body">
            <span class="task-item-title">${escapeHtml(t.title)}</span>
            ${time ? `<span class="task-item-time">${time}</span>` : ''}
          </div>
          <span class="task-color-dot" style="background:${t.color}"></span>
        </div>`;
      });
      html += '</div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('.task-check').forEach(cb => {
      cb.addEventListener('change', async () => {
        const item = cb.closest('.task-item');
        if (item) item.classList.toggle('task-done');
        try {
          const targetDate = cb.dataset.date || '';
          const qs = targetDate ? `?target_date=${targetDate}` : '';
          await Auth.request(`/events/${cb.dataset.id}/done${qs}`, { method: 'PATCH' });
          load();
        } catch (err) {
          UI.showToast(err.message, 'error');
          if (item) item.classList.toggle('task-done');
        }
      });
    });
  }

  // ── Event Modal ──

  let calClientOptions = [];

  async function loadClientOptions() {
    const user = Auth.getUser();
    const wrap = document.getElementById('evt-client-wrap');
    if (!user || !user.team_id) {
      wrap.style.display = 'none';
      calClientOptions = [];
      return;
    }
    try {
      calClientOptions = await Auth.request('/clients');
      const sel = document.getElementById('evt-client');
      sel.innerHTML = '<option value="">없음</option>' +
        calClientOptions.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
      wrap.style.display = '';
    } catch {
      wrap.style.display = 'none';
      calClientOptions = [];
    }
  }

  function getClientName(clientId) {
    if (!clientId) return '';
    const c = calClientOptions.find(x => x.id === clientId);
    return c ? c.name : '';
  }

  function openAddEvent(dateStr) {
    document.getElementById('event-modal-title').textContent = '일정 추가';
    document.getElementById('evt-submit-btn').textContent = '추가';
    document.getElementById('evt-delete-btn').classList.add('hidden');
    document.getElementById('event-form').reset();
    document.getElementById('evt-date').value = dateStr || '';
    document.getElementById('evt-color').value = '#4DA8DA';
    document.getElementById('evt-edit-id').value = '';
    document.getElementById('evt-recurrence-end-wrap').style.display = 'none';
    document.getElementById('evt-recurrence-day-wrap').style.display = 'none';
    document.getElementById('evt-skip-weekend-wrap').style.display = 'none';
    document.getElementById('evt-skip-weekend').checked = true;
    document.getElementById('evt-recurrence-day').value = '';
    document.getElementById('evt-client').value = '';
    resetColorPicker('evt-color-picker', '#4DA8DA');
    UI.openModal('event-modal');
  }

  function openEditEvent(id) {
    const ev = events.find(e => e.id === id);
    if (!ev) return;
    document.getElementById('event-modal-title').textContent = '일정 수정';
    document.getElementById('evt-submit-btn').textContent = '저장';
    document.getElementById('evt-delete-btn').classList.remove('hidden');
    document.getElementById('evt-edit-id').value = id;
    document.getElementById('evt-title').value = ev.title;
    document.getElementById('evt-date').value = ev.start_date;
    document.getElementById('evt-time').value = ev.start_time || '';
    document.getElementById('evt-end-date').value = ev.end_date || '';
    document.getElementById('evt-desc').value = ev.description || '';
    document.getElementById('evt-remind').value = ev.remind_minutes != null ? String(ev.remind_minutes) : '';
    document.getElementById('evt-recurrence').value = ev.recurrence_type || '';
    document.getElementById('evt-recurrence-end').value = ev.recurrence_end || '';
    const hasRecurrence = !!ev.recurrence_type;
    const isMonthly = ev.recurrence_type === 'monthly';
    document.getElementById('evt-recurrence-end-wrap').style.display = hasRecurrence ? '' : 'none';
    document.getElementById('evt-skip-weekend-wrap').style.display = hasRecurrence ? '' : 'none';
    document.getElementById('evt-recurrence-day-wrap').style.display = isMonthly ? '' : 'none';
    document.getElementById('evt-recurrence-day').value = isMonthly ? (ev.recurrence_day || new Date(ev.start_date + 'T00:00:00').getDate()) : '';
    document.getElementById('evt-skip-weekend').checked = ev.skip_weekend || false;
    document.getElementById('evt-is-task').checked = ev.is_task || false;
    document.getElementById('evt-color').value = ev.color || '#4DA8DA';
    document.getElementById('evt-client').value = ev.client_id || '';
    resetColorPicker('evt-color-picker', ev.color || '#4DA8DA');
    UI.openModal('event-modal');
  }

  function resetColorPicker(pickerId, activeColor) {
    document.getElementById(pickerId).querySelectorAll('.color-dot').forEach(d => {
      d.classList.toggle('active', d.dataset.color === activeColor);
    });
  }

  async function saveEvent(e) {
    e.preventDefault();
    const id = document.getElementById('evt-edit-id').value;
    const remindVal = document.getElementById('evt-remind').value;
    const recurrence = document.getElementById('evt-recurrence').value;

    let startDate = document.getElementById('evt-date').value;
    let recurrenceDay = null;
    if (recurrence === 'monthly') {
      const dayInput = document.getElementById('evt-recurrence-day').value;
      if (dayInput) {
        recurrenceDay = Math.min(31, Math.max(1, parseInt(dayInput, 10)));
        const parts = startDate.split('-');
        if (parts.length === 3) {
          const y = parseInt(parts[0], 10);
          const m = parseInt(parts[1], 10);
          const maxDay = new Date(y, m, 0).getDate();
          const day = Math.min(recurrenceDay, maxDay);
          startDate = `${parts[0]}-${parts[1]}-${String(day).padStart(2, '0')}`;
        }
      }
    }

    const clientVal = document.getElementById('evt-client').value;
    const data = {
      title: document.getElementById('evt-title').value.trim(),
      start_date: startDate,
      start_time: document.getElementById('evt-time').value || null,
      end_date: document.getElementById('evt-end-date').value || null,
      description: document.getElementById('evt-desc').value.trim() || null,
      color: document.getElementById('evt-color').value,
      remind_minutes: remindVal !== '' ? parseInt(remindVal, 10) : null,
      recurrence_type: recurrence || null,
      recurrence_end: recurrence ? (document.getElementById('evt-recurrence-end').value || null) : null,
      recurrence_interval: 1,
      recurrence_day: recurrenceDay,
      is_task: document.getElementById('evt-is-task').checked,
      skip_weekend: recurrence ? document.getElementById('evt-skip-weekend').checked : false,
      client_id: clientVal || null,
    };

    UI.closeModal('event-modal');
    try {
      if (id) {
        await Auth.request(`/events/${id}`, { method: 'PUT', body: JSON.stringify(data) });
        UI.showToast('일정이 수정되었습니다', 'success');
      } else {
        await Auth.request('/events', { method: 'POST', body: JSON.stringify(data) });
        UI.showToast('일정이 추가되었습니다', 'success');
      }
      load();
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  async function deleteCurrentEvent() {
    const id = document.getElementById('evt-edit-id').value;
    if (!id) return;
    const ok = await UI.confirm('삭제 확인', '이 일정을 삭제하시겠습니까?');
    if (!ok) return;
    UI.closeModal('event-modal');
    events = events.filter(e => e.id !== id);
    render();
    try {
      await Auth.request(`/events/${id}`, { method: 'DELETE' });
      UI.showToast('삭제되었습니다', 'success');
      load();
    } catch (err) {
      UI.showToast(err.message, 'error');
      load();
    }
  }

  // ── Notifications ──

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function scheduleNotifications() {
    notifyTimers.forEach(t => clearTimeout(t));
    notifyTimers = [];
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const now = new Date();
    (notifyEvents.length ? notifyEvents : events).forEach(ev => {
      if (ev.remind_minutes == null || !ev.start_time) return;
      const eventTime = new Date(`${ev.start_date}T${ev.start_time}`);
      const notifyTime = new Date(eventTime.getTime() - ev.remind_minutes * 60000);
      const delay = notifyTime.getTime() - now.getTime();

      if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
        const timer = setTimeout(() => {
          const remindText = ev.remind_minutes === 0 ? '지금' : `${ev.remind_minutes}분 후`;
          new Notification('LinkFlow - 일정 알림', {
            body: `${ev.title} (${remindText} 시작)`,
            icon: '/icons/icon-192.png',
            tag: ev.id,
          });
        }, delay);
        notifyTimers.push(timer);
      }
    });
  }

  const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    return str ? str.replace(/[&<>"']/g, c => _escMap[c]) : '';
  }

  return { init, load, openAddEvent, loadClientOptions, getClientName };
})();
