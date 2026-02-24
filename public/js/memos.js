const Memos = (() => {
  let memos = [];

  function init() {
    document.getElementById('btn-add-memo').addEventListener('click', openAddMemo);
    document.getElementById('btn-memo-empty-add')?.addEventListener('click', openAddMemo);
    document.getElementById('memo-form').addEventListener('submit', saveMemo);
    document.getElementById('memo-delete-btn').addEventListener('click', deleteCurrentMemo);

    document.getElementById('memo-color-picker').querySelectorAll('.color-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        document.getElementById('memo-color-picker').querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        document.getElementById('memo-color').value = dot.dataset.color;
      });
    });
  }

  async function load() {
    try {
      memos = await Auth.request('/memos');
    } catch {
      memos = [];
    }
    render();
  }

  function render() {
    const grid = document.getElementById('memos-grid');
    const empty = document.getElementById('memo-empty-state');

    if (memos.length === 0) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');

    grid.innerHTML = memos.map(m => {
      const pinIcon = m.is_pinned ? 'ri-pushpin-2-fill' : 'ri-pushpin-line';
      const pinClass = m.is_pinned ? 'pinned' : '';
      const preview = (m.content || '').substring(0, 120);
      return `
        <div class="memo-card ${pinClass}" data-id="${m.id}" style="background:${m.color || '#fff'}">
          <div class="memo-card-header">
            <span class="memo-card-title">${escapeHtml(m.title || '제목 없음')}</span>
            <button class="icon-btn memo-pin-btn" data-id="${m.id}" title="고정"><i class="${pinIcon}"></i></button>
          </div>
          <div class="memo-card-body">${escapeHtml(preview)}</div>
          <div class="memo-card-footer">
            <span class="memo-card-date">${formatDate(m.updated_at)}</span>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.memo-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.memo-pin-btn')) return;
        openEditMemo(card.dataset.id);
      });
    });

    grid.querySelectorAll('.memo-pin-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          await Auth.request(`/memos/${btn.dataset.id}/pin`, { method: 'PATCH' });
          load();
        } catch (err) {
          UI.showToast(err.message, 'error');
        }
      });
    });
  }

  function openAddMemo() {
    document.getElementById('memo-modal-title').textContent = '새 메모';
    document.getElementById('memo-delete-btn').classList.add('hidden');
    document.getElementById('memo-form').reset();
    document.getElementById('memo-edit-id').value = '';
    document.getElementById('memo-color').value = '#FFFFFF';
    resetColorPicker('#FFFFFF');
    UI.openModal('memo-modal');
    document.getElementById('memo-title').focus();
  }

  function openEditMemo(id) {
    const m = memos.find(x => x.id === id);
    if (!m) return;
    document.getElementById('memo-modal-title').textContent = '메모 수정';
    document.getElementById('memo-delete-btn').classList.remove('hidden');
    document.getElementById('memo-edit-id').value = id;
    document.getElementById('memo-title').value = m.title || '';
    document.getElementById('memo-content').value = m.content || '';
    document.getElementById('memo-color').value = m.color || '#FFFFFF';
    resetColorPicker(m.color || '#FFFFFF');
    UI.openModal('memo-modal');
  }

  function resetColorPicker(activeColor) {
    document.getElementById('memo-color-picker').querySelectorAll('.color-dot').forEach(d => {
      d.classList.toggle('active', d.dataset.color === activeColor);
    });
  }

  async function saveMemo(e) {
    e.preventDefault();
    const id = document.getElementById('memo-edit-id').value;
    const data = {
      title: document.getElementById('memo-title').value.trim(),
      content: document.getElementById('memo-content').value,
      color: document.getElementById('memo-color').value,
    };

    try {
      if (id) {
        await Auth.request(`/memos/${id}`, { method: 'PUT', body: JSON.stringify(data) });
        UI.showToast('메모가 저장되었습니다', 'success');
      } else {
        await Auth.request('/memos', { method: 'POST', body: JSON.stringify(data) });
        UI.showToast('메모가 생성되었습니다', 'success');
      }
      UI.closeModal('memo-modal');
      load();
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  async function deleteCurrentMemo() {
    const id = document.getElementById('memo-edit-id').value;
    if (!id) return;
    const ok = await UI.confirm('삭제 확인', '이 메모를 삭제하시겠습니까?');
    if (!ok) return;
    try {
      await Auth.request(`/memos/${id}`, { method: 'DELETE' });
      UI.showToast('삭제되었습니다', 'success');
      UI.closeModal('memo-modal');
      load();
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  return { init, load };
})();
