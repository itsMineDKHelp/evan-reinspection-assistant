// One quick-fill hotkey for manual work: Ctrl+Shift+Q, reachable one-handed (pinky+ring on the
// modifiers, index on Q) and not a Chrome/OS-reserved shortcut. It checks which EvAN screen is
// open and does the matching action:
//
//  - Building-edit screen: fills the "start a reinspection" boilerplate fields, without
//    touching the excel/grouping fields at all.
//  - PNOT note screen: clicks Add, then adds a note "<inspector code> Reinspection Update"
//    (e.g. "H91 Reinspection Update").

(function () {
  const { FIELDS, $, setFieldById, todayYYYYMMDD, addPnotNote } = window.EvanFields;

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

  function onBuildingEditScreen() {
    return !!$(FIELDS.inspectorNew);
  }

  function onPnotScreen() {
    return !!$(FIELDS.pnotAddButton);
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

  function withInspectorCode(callback) {
    chrome.storage.local.get(['inspectorCode'], (data) => {
      const inspectorCode = (data.inspectorCode || '').trim();
      if (!inspectorCode) {
        showToast('Set an inspector code in the extension popup first.', true);
        return;
      }
      callback(inspectorCode);
    });
  }

  function quickFillBuildingEdit() {
    withInspectorCode((inspectorCode) => {
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

  function quickPnotNote() {
    withInspectorCode(async (inspectorCode) => {
      const noteText = `${inspectorCode} Reinspection Update`;
      try {
        const submitted = await addPnotNote(noteText);
        showToast(submitted ? 'Note added.' : 'Note typed, but no submit button was found, check it manually.', !submitted);
      } catch (err) {
        showToast('Quick-note failed: ' + (err && err.message ? err.message : err), true);
      }
    });
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!hotkeyEnabled) return;
      if (!e.ctrlKey || !e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'q') return;

      e.preventDefault();
      if (onBuildingEditScreen()) {
        quickFillBuildingEdit();
      } else if (onPnotScreen()) {
        quickPnotNote();
      } else {
        showToast('Quick-fill: not on a building-edit or PNOT screen.', true);
      }
    },
    true
  );
})();
