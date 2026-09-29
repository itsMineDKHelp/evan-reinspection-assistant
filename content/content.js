// Bridges messages from the background script to the automation engine.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PROCESS_ROW') {
    window.EvanAutomation.processRow(message.row, message.settings)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // keep the message channel open for the async response
  }
  if (message.type === 'PING') {
    sendResponse({ ok: true });
  }
  return false;
});
