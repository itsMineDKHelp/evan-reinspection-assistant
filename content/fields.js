// Shared field IDs and DOM helpers used by both the bulk automation and the quick-fill hotkey.
// Loaded as a plain script (no modules) so everything here lives on window.EvanFields.

(function () {
  const FIELDS = {
    searchBar: 'xact_quicknav_form:transLineField',
    goButton: 'xact_quicknav_form:goButton',
    editLinkRow: (row) => `nonValidatingAjaxForm:tblbldgDisplay:${row}:editlink2`,
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

  window.EvanFields = {
    FIELDS,
    CODE_SLOT_COUNT,
    $,
    sleep,
    waitFor,
    waitForElement,
    setFieldValue,
    setFieldById,
    todayYYYYMMDD,
    clickElement,
  };
})();
