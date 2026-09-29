// Quick-fill hotkey: fills the "start a reinspection" boilerplate fields on the building-edit
// screen for someone working manually, without touching the excel/grouping fields at all.
//
// Combo: Ctrl+Shift+Q. Picked because it's reachable one-handed (pinky+ring on the modifiers,
// index on Q) and Ctrl+Shift+<letter> combos are rarely claimed by the browser or by EvAN itself.

(function () {
  const { FIELDS, $, setFieldById, todayYYYYMMDD } = window.EvanFields;

  let hotkeyEnabled = false;

  function refreshEnabledState() {
    chrome.storage.local.get(['hotkeyEnabled'], (data) => {
      hotkeyEnabled = !!data.hotkeyEnabled;
    });
  }
  refreshEnabledState();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.hotkeyEnabled) {
      hotkeyEnabled = !!changes.hotkeyEnabled.newValue;
    }
  });

  function onEditScreen() {
    return !!$(FIELDS.inspectorNew);
  }

  function showToast(message, isError) {
    const existing = document.getElementById('evan-assistant-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'evan-assistant-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 999999;
      background: ${isError ? '#b91c1c' : '#15803d'}; color: #fff;
      padding: 10px 16px; border-radius: 6px; font: 13px/1.4 system-ui, sans-serif;
      box-shadow: 0 2px 10px rgba(0,0,0,.25); max-width: 320px;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  function isFieldLocked(el) {
    return !el || el.disabled || el.readOnly;
  }

  function quickFill() {
    if (!onEditScreen()) {
      showToast('Quick-fill: not on a building-edit screen.', true);
      return;
    }

    chrome.storage.local.get(['inspectorCode'], (data) => {
      const inspectorCode = (data.inspectorCode || '').trim();
      if (!inspectorCode) {
        showToast('Quick-fill: set an inspector code in the extension popup first.', true);
        return;
      }

      setFieldById(FIELDS.ncmicReasonDetails, 'reinspection update');
      setFieldById(FIELDS.ncmicReasonNew, 'OTHER_NO_SPM_NCMIC');
      setFieldById(FIELDS.assessmentProcess1, 'RE-INSPECTION');

      const mda = $(FIELDS.costFlat);
      if (!isFieldLocked(mda)) setFieldById(FIELDS.costFlat, '0');

      const overVal = $(FIELDS.overrideValue);
      if (!isFieldLocked(overVal)) setFieldById(FIELDS.overrideValue, '0');

      const rcnOver = $(FIELDS.rcnOver);
      if (!isFieldLocked(rcnOver)) setFieldById(FIELDS.rcnOver, '0');

      setFieldById(FIELDS.inspectorNew, inspectorCode);
      setFieldById(FIELDS.inspCodeNew, 'V');
      setFieldById(FIELDS.inspDateNewInputDate, todayYYYYMMDD());

      showToast('Quick-fill applied.');
    });
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!hotkeyEnabled) return;

      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        quickFill();
      }
    },
    true
  );
})();
