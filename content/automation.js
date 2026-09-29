// Bulk reinspection automation: drives one PAN through the building-edit screen and the PNOT
// note screen. Grouping matching and row filtering already happened before this runs (in the
// background script) - this file only touches the DOM.

(function () {
  const { FIELDS, CODE_SLOT_COUNT, $, sleep, waitFor, waitForElement, setFieldById, todayYYYYMMDD, clickElement } =
    window.EvanFields;

  function isFieldLocked(el) {
    return !el || el.disabled || el.readOnly;
  }

  function goto(command) {
    const bar = $(FIELDS.searchBar);
    if (!bar) throw new Error('Search bar not found');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(bar, command);
    bar.dispatchEvent(new Event('input', { bubbles: true }));
    const goButton = $(FIELDS.goButton);
    if (!goButton) throw new Error('Go button not found');
    clickElement(goButton);
  }

  function readCodeSlots() {
    const slots = [];
    for (let n = 1; n <= CODE_SLOT_COUNT; n++) {
      const codeEl = $(FIELDS.codeField(n));
      const areaEl = $(FIELDS.areaField(n));
      if (!codeEl) continue;
      slots.push({ n, codeEl, areaEl, code: parseInt(codeEl.value, 10) || 0 });
    }
    return slots;
  }

  function apply803to802() {
    for (const slot of readCodeSlots()) {
      if (slot.code === 803) {
        setFieldById(slot.codeEl.id, '0802');
      }
    }
  }

  // Returns true if a 736 slot was added, false if nothing needed to happen or there was no
  // free slot (in which case `pendingReason` on the result gets set by the caller).
  function apply736ForGarage(ageValue) {
    const age = parseInt(ageValue, 10);
    if (!(age >= 1990)) return { added: false, pending: false };

    const slots = readCodeSlots();
    const garageSlot = slots.find((s) => s.code === 701);
    if (!garageSlot) return { added: false, pending: false };

    const garageAreaValue = garageSlot.areaEl ? garageSlot.areaEl.value : '';
    const freeSlot = slots.find((s) => s.code === 0);
    if (!freeSlot) return { added: false, pending: true };

    setFieldById(freeSlot.codeEl.id, '0736');
    if (freeSlot.areaEl) setFieldById(freeSlot.areaEl.id, garageAreaValue);
    return { added: true, pending: false };
  }

  async function openBuildingEdit(panSearchId) {
    goto(`bldg ${panSearchId}`);
    await waitForElement(FIELDS.editLinkRow(0), { timeout: 10000 });
    const editLink = $(FIELDS.editLinkRow(0));
    clickElement(editLink);
    await waitForElement(FIELDS.inspectorNew, { timeout: 10000 });
  }

  function fillBoilerplateFields(inspectorCode, netConditionPercent, groupingNumber) {
    setFieldById(FIELDS.inspectorNew, inspectorCode);
    setFieldById(FIELDS.inspCodeNew, 'V');
    setFieldById(FIELDS.inspDateNewInputDate, todayYYYYMMDD());
    setFieldById(FIELDS.netCond, String(netConditionPercent));
    setFieldById(FIELDS.group2, String(groupingNumber));
    setFieldById(FIELDS.ncmicReasonDetails, 'reinspection update');
    setFieldById(FIELDS.ncmicReasonNew, 'OTHER_NO_SPM_NCMIC');
    setFieldById(FIELDS.assessmentProcess1, 'RE-INSPECTION');

    const mda = $(FIELDS.costFlat);
    if (!isFieldLocked(mda)) setFieldById(FIELDS.costFlat, '0');
    const overVal = $(FIELDS.overrideValue);
    if (!isFieldLocked(overVal)) setFieldById(FIELDS.overrideValue, '0');
    const rcnOver = $(FIELDS.rcnOver);
    if (!isFieldLocked(rcnOver)) setFieldById(FIELDS.rcnOver, '0');
  }

  async function calculateAndSave() {
    const calcButton = $(FIELDS.calculate);
    clickElement(calcButton);

    // The calculate button opens a confirmation panel whose own Save button actually persists
    // the record (see calculateConfirmationPanel in the page). Wait for it to show up.
    const saveButton = await waitFor(
      () => {
        const candidates = Array.from(document.querySelectorAll('input[type="submit"][value="Save"]'));
        return candidates.find((el) => el.offsetParent !== null) || null;
      },
      { timeout: 10000 }
    );
    clickElement(saveButton);

    const banner = await waitFor(
      () => {
        const el = document.querySelector('.rich-messages-label');
        return el && /GROSS ASSMT/.test(el.textContent) ? el : null;
      },
      { timeout: 10000 }
    );
    return banner.textContent;
  }

  function parseGrossAssmt(bannerText) {
    const match = bannerText.match(/GROSS ASSMT\s*=\s*([\d,]+)/i);
    if (!match) return null;
    return parseInt(match[1].replace(/,/g, ''), 10);
  }

  // Finds the note textarea that appears after clicking Add on the PNOT screen. There's no
  // stable id for it (JSF generated), so we grab the only textarea that becomes visible.
  async function findPnotTextarea() {
    const before = new Set(Array.from(document.querySelectorAll('textarea')));
    const addButton = $(FIELDS.pnotAddButton);
    clickElement(addButton);

    return waitFor(() => {
      const areas = Array.from(document.querySelectorAll('textarea')).filter((t) => t.offsetParent !== null);
      const fresh = areas.find((t) => !before.has(t));
      return fresh || areas[0] || null;
    }, { timeout: 8000 });
  }

  function setTextareaValue(el, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function addPnotNote(panSearchId, noteText) {
    goto(`PNOT ${panSearchId}`);
    await waitForElement(FIELDS.pnotAddButton, { timeout: 10000 });
    const textarea = await findPnotTextarea();
    setTextareaValue(textarea, noteText);

    // No submit button id was given for this popup; best effort: look for a visible
    // Save/OK/Submit button inside the same dialog and click it.
    const container = textarea.closest('.rich-modalpanel, .rf-pp, [id*="Panel"]') || document.body;
    const submitBtn = Array.from(
      container.querySelectorAll('input[type="submit"], input[type="button"], button')
    ).find((el) => /save|ok|submit|add/i.test(el.value || el.textContent || '') && el.offsetParent !== null);
    if (submitBtn) {
      clickElement(submitBtn);
      await sleep(300);
      return true;
    }
    return false; // caller should flag this PAN as needing manual note confirmation
  }

  async function processRow(row, settings) {
    const { panSearchId, netConditionPercent, groupingNumber, groupingLabel } = row;
    const { inspectorCode } = settings;

    await openBuildingEdit(panSearchId);

    fillBoilerplateFields(inspectorCode, netConditionPercent, groupingNumber);
    apply803to802();

    const ageEl = $(FIELDS.age);
    const garageResult = apply736ForGarage(ageEl ? ageEl.value : '0');

    const bannerText = await calculateAndSave();
    const value = parseGrossAssmt(bannerText);

    let note = `${inspectorCode}, Grouping ${groupingNumber} ${groupingLabel}, ${netConditionPercent}%`;
    if (garageResult.added) note += ', added 736';

    const noteSubmitted = await addPnotNote(panSearchId, note);

    return {
      pan: row.pan,
      value,
      note,
      pendingGarage736: garageResult.pending,
      noteSubmitted,
    };
  }

  window.EvanAutomation = { processRow };
})();
