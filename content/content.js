(() => {
  const DEFAULTS = { ballEnabled: true, minImageSize: 120 };
  let settings = { ...DEFAULTS };
  let ball = null;
  let currentImg = null;
  let hideTimer = null;

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.ballEnabled) settings.ballEnabled = changes.ballEnabled.newValue;
    if (changes.minImageSize) settings.minImageSize = changes.minImageSize.newValue;
    if (!settings.ballEnabled) hideBall();
  });

  function createBall() {
    ball = document.createElement('div');
    ball.id = 'prompt-lens-ball';
    ball.title = 'Prompt Lens：反推这张图的提示词';
    ball.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>' +
      '<path d="M8.5 11a2.5 2.5 0 0 1 2.5-2.5"/></svg>';

    ball.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    ball.addEventListener('mouseleave', scheduleHide);
    ball.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!currentImg) return;
      const srcUrl = currentImg.currentSrc || currentImg.src;
      if (!srcUrl) return;
      chrome.runtime.sendMessage({
        type: 'ANALYZE_IMAGE',
        payload: { srcUrl, pageUrl: location.href }
      });
      showToast('已开始反推，结果稍后显示在侧边栏');
      hideBall();
    });
    document.documentElement.appendChild(ball);
  }

  function showBallFor(img) {
    if (!settings.ballEnabled) return;
    const rect = img.getBoundingClientRect();
    if (rect.width < settings.minImageSize || rect.height < settings.minImageSize) return;
    if (!ball) createBall();
    currentImg = img;
    const size = 34;
    const top = Math.max(4, rect.top + 8);
    const left = Math.min(window.innerWidth - size - 4, rect.right - size - 8);
    ball.style.top = `${top}px`;
    ball.style.left = `${left}px`;
    ball.classList.add('prompt-lens-visible');
    clearTimeout(hideTimer);
  }

  function hideBall() {
    if (ball) ball.classList.remove('prompt-lens-visible');
    currentImg = null;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideBall, 250);
  }

  function showToast(text) {
    const toast = document.createElement('div');
    toast.className = 'prompt-lens-toast';
    toast.textContent = text;
    document.documentElement.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('prompt-lens-visible'));
    setTimeout(() => {
      toast.classList.remove('prompt-lens-visible');
      setTimeout(() => toast.remove(), 300);
    }, 2200);
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLImageElement) {
        showBallFor(t);
      } else if (t !== ball && !ball?.contains(t) && currentImg && !currentImg.contains(t)) {
        scheduleHide();
      }
    },
    true
  );

  window.addEventListener('scroll', hideBall, { passive: true, capture: true });
})();
