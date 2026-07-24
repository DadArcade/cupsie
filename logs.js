document.addEventListener('DOMContentLoaded', () => {
  loadLogs();
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadLogs);
  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearLogs);
  const downloadBtn = document.getElementById('downloadBtn');
  if (downloadBtn) downloadBtn.addEventListener('click', downloadLogs);
});

// Listen to storage updates to automatically refresh if changes happen live
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (changes.logs) {
    renderLogs(changes.logs.newValue || []);
  }
});

async function loadLogs() {
  try {
    const items = await chrome.storage.local.get(['logs']);
    renderLogs(items ? items.logs || [] : []);
  } catch (e) {
    console.error('Failed to retrieve logs:', e);
  }
}

function renderLogs(logs) {
  const list = document.getElementById('logList');
  if (!list) return;
  list.innerHTML = '';

  const emptyState = document.getElementById('emptyState');
  const downloadBtn = document.getElementById('downloadBtn');

  if (logs.length === 0) {
    list.style.display = 'none';
    if (emptyState) emptyState.style.display = 'block';
    if (downloadBtn) downloadBtn.disabled = true;
    return;
  }

  list.style.display = 'block';
  if (emptyState) emptyState.style.display = 'none';
  if (downloadBtn) downloadBtn.disabled = false;

  // Show newest logs at the top
  const sortedLogs = [...logs].reverse();

  for (const log of sortedLogs) {
    const li = document.createElement('li');
    li.className = 'log-item';

    const timeDiv = document.createElement('div');
    timeDiv.className = 'time';
    const date = new Date(log.timestamp);
    timeDiv.textContent = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();

    const levelDiv = document.createElement('div');
    const badge = document.createElement('span');
    badge.className = `badge badge-${log.level}`;
    badge.textContent = log.level;
    levelDiv.appendChild(badge);

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    messageDiv.textContent = log.message;

    li.appendChild(timeDiv);
    li.appendChild(levelDiv);
    li.appendChild(messageDiv);
    list.appendChild(li);
  }
}

async function clearLogs() {
  if (confirm(chrome.i18n.getMessage('confirmClearLogs'))) {
    try {
      await chrome.storage.local.set({ logs: [] });
      await loadLogs();
    } catch (e) {
      console.error('Failed to clear logs:', e);
    }
  }
}

async function downloadLogs() {
  let items;
  try {
    items = await chrome.storage.local.get(['logs']);
  } catch (e) {
    console.error('Failed to retrieve logs for download:', e);
    return;
  }
  const logs = items ? items.logs || [] : [];
  if (logs.length === 0) return;

    let text = chrome.i18n.getMessage('downloadHeaderTitle') + '\n';
    text += '======================================\n\n';

    for (const log of logs) {
      let timeStr = 'UNKNOWN_TIME';
      try {
        const date = new Date(log.timestamp);
        if (!isNaN(date.getTime())) {
          timeStr = date.toISOString();
        }
      } catch (e) {
        console.error('Failed to parse log timestamp:', log.timestamp, e);
      }
      text += `[${timeStr}] [${(log.level || 'info').toUpperCase()}] ${log.message || ''}\n`;
    }

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `cupsie_logs_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();

    // Clean up
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
}
