// Bridges messages from the background script to the automation engine. Navigation itself is
// done by background directly (chrome.tabs.update), not through here - see background.js.
//
// Guarded so that if background force-injects this file again (see ensureContentScriptInjected
// in background.js, for tabs that were already open before the extension was loaded/reloaded -
// Chrome doesn't retroactively run content_scripts into those), it doesn't register a second
// message listener and answer every message twice.

if (!window.__evanAssistantLoaded) {
  window.__evanAssistantLoaded = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'FILL_AND_SAVE_BUILDING') {
      window.EvanAutomation.fillAndSaveBuilding(message.row, message.settings)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true;
    }

    if (message.type === 'ADD_PNOT_NOTE') {
      window.EvanAutomation.addPnotNoteOnly(message.panSearchId, message.noteText)
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
}
