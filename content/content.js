// Bridges messages from the background script to the automation engine. Each message maps to
// one same-page step - navigation itself is triggered here but never awaited, since the
// resulting page load destroys this script's context (see automation.js for why).

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRIGGER_NAV') {
    try {
      window.EvanAutomation.triggerNavigate(message.command);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
    return false;
  }

  if (message.type === 'FILL_AND_SAVE_BUILDING') {
    window.EvanAutomation.fillAndSaveBuilding(message.row, message.settings)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (message.type === 'ADD_PNOT_NOTE') {
    window.EvanAutomation.addPnotNoteOnly(message.noteText)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (message.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
