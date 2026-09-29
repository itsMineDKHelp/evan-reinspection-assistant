// Shared field IDs and DOM helpers used by both the bulk automation and the quick-fill hotkey.
// Loaded as a plain script (no modules) so everything here lives on window.EvanFields.

(function () {
  const FIELDS = {
    searchBar: 'xact_quicknav_form:transLineField',
    goButton: 'xact_quicknav_form:goButton',
    inspectorNew: 'screen_form:inspectorNew',
    inspCodeNew: 'screen_form:inspCodeNew',
    inspDateNewInputDate: 'screen_form:inspDateNewInputDate',
    netCond: 'screen_form:netCond',
    group2: 'screen_form:group2',
    ncmicReasonDetails: 'screen_form:ncmicReasonDetails',
    ncmicReasonNew: 'screen_form:ncmicReasonNew',
    assessmentProcess1: 'screen_form:AssessmentProcess1',
    costFlat: 'screen_form:costFlat',
    overrideValue: 'screen_form:overrideValue',
    rcnOver: 'screen_form:rcnOver',
    age: 'screen_form:age',
    calculate: 'screen_form:calculate',
    codeField: (n) => `screen_form:code${n}`,
    areaField: (n) => `screen_form:area${n}`,
    pnotAddButton: 'nonValidatingAjaxForm:addlink',
  };

  const CODE_SLOT_COUNT = 9;

  function $(id) {
    return document.getElementById(id);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Poll until predicate() returns a truthy value, or reject on timeout.
  // Used instead of fixed sleeps so we only wait as long as EvAN's AJAX call actually takes.
  function waitFor(predicate, { timeout = 8000, interval = 80 } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        let result;
        try {
          result = predicate();
        } catch (e) {
          result = false;
        }
        if (result) {
          resolve(result === true ? true : result);
          return;
        }
        if (Date.now() - start >= timeout) {
          reject(new Error('waitFor timed out'));
          return;
        }
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function waitForElement(id, opts) {
    return waitFor(() => $(id), opts);
  }

  // Best-effort check that the search/"Trans:" box reflects the PAN we just navigated to, as a
  // guard against acting on stale content before EvAN swaps in the new PAN's data (the edit
  // link and PNOT add button use the same id on every PAN's page). This is NOT relied on as a
  // hard gate - unconfirmed behavior on the real field (it may clear itself after a command
  // runs, in which case this would never resolve) means a step must still be able to proceed
  // when this simply times out. Callers should catch/ignore rejection rather than let it kill
  // the step; see waitForTransactionReadyBestEffort below.
  function waitForTransactionReady(panSearchId, opts) {
    return waitFor(() => {
      const bar = $(FIELDS.searchBar);
      return bar && bar.value && bar.value.includes(panSearchId);
    }, { timeout: 15000, ...opts });
  }

  async function waitForTransactionReadyBestEffort(panSearchId, opts) {
    try {
      await waitForTransactionReady(panSearchId, { timeout: 3000, ...opts });
    } catch (e) {
      // Didn't confirm in time - proceed anyway rather than blocking the whole step on an
      // unverified assumption about this field's behavior.
    }
  }

  // Sets a value on an input the way a real user would (so JSF's onblur/onchange handlers,
  // like allowOnlyInts, actually fire) instead of just mutating .value directly.
  function setFieldValue(el, value) {
    if (!el) return false;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  function setFieldById(id, value) {
    return setFieldValue($(id), value);
  }

  function todayYYYYMMDD() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  function clickElement(el) {
    if (!el) return false;
    el.click();
    return true;
  }

  function setTextareaValue(el, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Clicks Add on the PNOT screen and finds the note textarea that appears. There's no stable
  // id for it (JSF generated), so this grabs whichever textarea newly became visible.
  async function openPnotNoteBox() {
    const before = new Set(Array.from(document.querySelectorAll('textarea')));
    clickElement($(FIELDS.pnotAddButton));

    return waitFor(() => {
      const areas = Array.from(document.querySelectorAll('textarea')).filter((t) => t.offsetParent !== null);
      const fresh = areas.find((t) => !before.has(t));
      return fresh || areas[0] || null;
    }, { timeout: 8000 });
  }

  // Best effort: no submit button id was given for the PNOT note popup, so this looks for a
  // visible Save/OK/Submit/Add-ish button inside the same dialog and clicks it.
  function submitPnotPopup(textarea) {
    const container = textarea.closest('.rich-modalpanel, .rf-pp, [id*="Panel"]') || document.body;
    const submitBtn = Array.from(
      container.querySelectorAll('input[type="submit"], input[type="button"], button')
    ).find((el) => /save|ok|submit|add/i.test(el.value || el.textContent || '') && el.offsetParent !== null);
    if (submitBtn) {
      clickElement(submitBtn);
      return true;
    }
    return false;
  }

  // panSearchId is optional: pass it when this follows an automated navigation (to confirm the
  // right PAN's page actually loaded before touching anything), omit it for the manual hotkey
  // where the user is already looking at the screen themselves.
  //
  // submit (default true): the bulk run is unattended so it must submit the note itself; the
  // manual hotkey passes false to leave the popup open with the note prefilled so the person can
  // review it before saving themselves.
  async function addPnotNote(panSearchId, noteText, { submit = true } = {}) {
    if (panSearchId) await waitForTransactionReadyBestEffort(panSearchId);
    await waitForElement(FIELDS.pnotAddButton, { timeout: 10000 });
    const textarea = await openPnotNoteBox();
    setTextareaValue(textarea, noteText);
    if (!submit) return false;
    const submitted = submitPnotPopup(textarea);
    if (submitted) await sleep(300);
    return submitted;
  }

  window.EvanFields = {
    FIELDS,
    CODE_SLOT_COUNT,
    $,
    sleep,
    waitFor,
    waitForElement,
    waitForTransactionReady,
    waitForTransactionReadyBestEffort,
    setFieldValue,
    setFieldById,
    todayYYYYMMDD,
    clickElement,
    setTextareaValue,
    openPnotNoteBox,
    submitPnotPopup,
    addPnotNote,
  };
})();
