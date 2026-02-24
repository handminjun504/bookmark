const UI = (() => {
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(60px)';
      toast.style.transition = '0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function openModal(id) {
    document.getElementById(id)?.classList.remove('hidden');
  }

  function closeModal(id) {
    document.getElementById(id)?.classList.add('hidden');
  }

  function confirm(title, message) {
    return new Promise(resolve => {
      const dialog = document.getElementById('confirm-dialog');
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-message').textContent = message;
      dialog.classList.remove('hidden');

      const okBtn = document.getElementById('confirm-ok');
      const cancelBtn = document.getElementById('confirm-cancel');

      function cleanup() {
        dialog.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
      }

      function onOk() { cleanup(); resolve(true); }
      function onCancel() { cleanup(); resolve(false); }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
    });
  }

  function showPanel(id) {
    document.getElementById(id)?.classList.remove('hidden');
    document.getElementById('panel-overlay')?.classList.remove('hidden');
  }

  function hidePanel(id) {
    document.getElementById(id)?.classList.add('hidden');
    document.getElementById('panel-overlay')?.classList.add('hidden');
  }

  function hideAllPanels() {
    document.querySelectorAll('.side-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById('panel-overlay')?.classList.add('hidden');
  }

  function setLoading(btn, loading) {
    if (loading) btn.classList.add('loading');
    else btn.classList.remove('loading');
  }

  const SERVICE_TYPES = {
    web: { label: '웹사이트', icon: 'ri-global-line' },
    server: { label: '서버', icon: 'ri-server-line' },
    apps_script: { label: '구글 앱스', icon: 'ri-google-line' },
    api: { label: 'API', icon: 'ri-flashlight-line' },
    other: { label: '기타', icon: 'ri-bookmark-line' },
  };

  function getTypeInfo(type) {
    return SERVICE_TYPES[type] || SERVICE_TYPES.other;
  }

  return { showToast, openModal, closeModal, confirm, showPanel, hidePanel, hideAllPanels, setLoading, getTypeInfo };
})();
