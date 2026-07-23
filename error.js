document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const title = urlParams.get('title') || chrome.i18n.getMessage('printErrorHeader');
  const message = urlParams.get('message') || chrome.i18n.getMessage('unknownErrorOccurred');

  const titleEl = document.getElementById('title');
  if (titleEl) {
    titleEl.textContent = title;
  }

  const messageEl = document.getElementById('message');
  if (messageEl) {
    messageEl.textContent = message;
  }

  const closeBtn = document.getElementById('closeBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      window.close();
    });
  }
});
