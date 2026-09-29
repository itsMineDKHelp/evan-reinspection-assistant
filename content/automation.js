// Bulk reinspection automation: drives one PAN through the building-edit screen and the PNOT
// note screen. Grouping matching and row filtering already happened before this runs (in the
// background script) - this file only touches the DOM.
//
// IMPORTANT: the quicknav search bar + Go button causes a full page navigation (a new EvAN
// screen loads), not an in-page AJAX update. That destroys this content script's execution
// context mid-flight. So navigation is never awaited from in here - the background script
// triggers a nav, then waits for the tab to finish reloading (a fresh copy of this script gets
// injected automatically), and only then sends the next step. Everything *within* one step
// below (edit link, field fills, calculate/save, the PNOT add popup) is same-page AJAX and is
// safe to await normally.

(function () {
  const {
    FIELDS,
    CODE_SLOT_COUNT,
    $,
    waitFor,
    waitForElement,
    setFieldById,
    todayYYYYMMDD,
    clickElement,
    addPnotNote,
  } = window.EvanFields;

  function isFieldLocked(el) {
    return !el || el.disabled || el.readOnly;
  }

  // Fire-and-forget: sets the search bar and clicks Go. Does not wait for the resulting
  // navigation - the caller (background) polls the tab for load completion instead.
  function triggerNavigate(command) {
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
  // free slot (in which case `pending` on the result gets set).
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

  // --- Step entry points, called by content.js in response to background messages ---

  // Step 1: called right after navigating to "bldg <pan>". Clicks the edit link (AJAX, safe to
  // await), fills every field, applies the 803/736 code rules, calculates and saves.
  async function fillAndSaveBuilding(row, settings) {
    await waitForElement(FIELDS.editLinkRow(0), { timeout: 10000 });
    clickElement($(FIELDS.editLinkRow(0)));
    await waitForElement(FIELDS.inspectorNew, { timeout: 10000 });

    fillBoilerplateFields(settings.inspectorCode, row.netConditionPercent, row.groupingNumber);
    apply803to802();

    const ageEl = $(FIELDS.age);
    const garageResult = apply736ForGarage(ageEl ? ageEl.value : '0');

    const bannerText = await calculateAndSave();
    const value = parseGrossAssmt(bannerText);

    return { value, garageAdded: garageResult.added, garagePending: garageResult.pending };
  }

  // Step 2: called right after navigating to "PNOT <pan>". Clicks Add, fills the note, submits.
  async function addPnotNoteOnly(noteText) {
    const noteSubmitted = await addPnotNote(noteText);
    return { noteSubmitted };
  }

  window.EvanAutomation = { triggerNavigate, fillAndSaveBuilding, addPnotNoteOnly };
})();
