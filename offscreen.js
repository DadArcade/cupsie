// offscreen.js
// Connect to the service worker to keep it alive
const port = chrome.runtime.connect({ name: 'keepAlive' });

// Send a message every 10 seconds to keep the connection active
const intervalId = setInterval(() => {
  port.postMessage('ping');
}, 10000);

port.onDisconnect.addListener(() => {
  clearInterval(intervalId);
});
