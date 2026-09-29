// Bulk reinspection automation: drives one PAN through the building-edit screen and the PNOT
// note screen. Grouping matching and row filtering already happened before this runs (in the
// background script) - this file only touches the DOM.
//
// IMPORTANT: the quicknav search bar + Go button navigates EvAN to a new screen, sometimes via
// a full page reload (which destroys this content script's execution context mid-flight),
// sometimes via an in-page AJAX swap (same script instance keeps running). Either way, the
// background script never tries to detect which kind it was - it just triggers the nav and
// sends the next step message right after. Each step below starts by waiting for EvAN's own
// "Trans:" box to actually show the target PAN before touching anything, which is the one
// signal that's reliable regardless of which kind of navigation just happened, and protects
// against clicking a stale element (the edit link / PNOT add button use the same id on every
// PAN's page) before the new PAN's content has actually swapped in.

(function () {
  const {
    FIELDS,
    CODE_SLOT_COUNT,
    $,
    waitFor,
    waitForElement,
    waitForTransactionReadyBestEffort,
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
    const saveButton = await waitWithDiagnostics(
      () => {
        const candidates = Array.from(document.querySelectorAll('input[type="submit"][value="Save"]'));
        return candidates.find((el) => el.offsetParent !== null) || null;
      },
      'save confirmation button never appeared after Calculate',
      { timeout: 10000 }
    );
    clickElement(saveButton);

    const banner = await waitWithDiagnostics(
      () => {
        const el = document.querySelector('.rich-messages-label');
        return el && /GROSS ASSMT/.test(el.textContent) ? el : null;
      },
      'GROSS ASSMT banner never appeared after Save',
      { timeout: 10000 }
    );
    return banner.textContent;
  }

  function parseGrossAssmt(bannerText) {
    const match = bannerText.match(/GROSS ASSMT\s*=\s*([\d,]+)/i);
    if (!match) return null;
    return parseInt(match[1].replace(/,/g, ''), 10);
  }

  // Builds a snapshot of what's actually on screen when a wait times out, so a failed row's
  // reason says something useful instead of just "waitFor timed out" - there's no way to verify
  // page behavior against the live site from outside the browser, so this is how the next
  // failure tells us what's really happening.
  function pageDiagnostics() {
    const bar = $(FIELDS.searchBar);
    const anyEditLinks = Array.from(document.querySelectorAll('[id*="editlink2"]')).map((el) => el.id);
    return [
      `url=${location.href}`,
      `title=${document.title || ''}`,
      `searchBarValue=${bar ? JSON.stringify(bar.value) : 'missing'}`,
      `editLinksFound=[${anyEditLinks.join(', ')}]`,
      `alreadyOnEditScreen=${!!$(FIELDS.inspectorNew)}`,
    ].join(' | ');
  }

  async function waitWithDiagnostics(predicate, label, opts) {
    try {
      return await waitFor(predicate, opts);
    } catch (e) {
      throw new Error(`${label} - ${pageDiagnostics()}`);
    }
  }

  // --- Step entry points, called by content.js in response to background messages ---

  // Step 1: called right after navigating to "bldg <pan>". Confirms the right PAN actually
  // loaded, clicks the edit link, fills every field, applies the 803/736 code rules, calculates
  // and saves.
  async function fillAndSaveBuilding(row, settings) {
    // The building-list screen's own state before the edit link is clicked isn't confirmed, so
    // this stays best-effort. Once on the actual edit screen, the search bar is confirmed to
    // read like "PZS1 05262306,2,2027" - that's checked for real below.
    await waitForTransactionReadyBestEffort(row.panSearchId);
    await waitWithDiagnostics(() => $(FIELDS.editLinkRow(0)), 'edit link never appeared', { timeout: 15000 });
    clickElement($(FIELDS.editLinkRow(0)));
    await waitWithDiagnostics(() => $(FIELDS.inspectorNew), 'edit form never opened after clicking edit link', { timeout: 15000 });
    await waitWithDiagnostics(
      () => {
        const bar = $(FIELDS.searchBar);
        return bar && bar.value && bar.value.includes(row.panSearchId);
      },
      'edit form opened but for a different PAN than expected (stale content)',
      { timeout: 10000 }
    );

    fillBoilerplateFields(settings.inspectorCode, row.netConditionPercent, row.groupingNumber);
    apply803to802();

    const ageEl = $(FIELDS.age);
    const garageResult = apply736ForGarage(ageEl ? ageEl.value : '0');

    const bannerText = await calculateAndSave();
    const value = parseGrossAssmt(bannerText);

    return { value, garageAdded: garageResult.added, garagePending: garageResult.pending };
  }

  // Step 2: called right after navigating to "PNOT <pan>". Confirms the right PAN actually
  // loaded, clicks Add, fills the note, submits.
  async function addPnotNoteOnly(panSearchId, noteText) {
    const noteSubmitted = await addPnotNote(panSearchId, noteText);
    return { noteSubmitted };
  }

  window.EvanAutomation = { triggerNavigate, fillAndSaveBuilding, addPnotNoteOnly };
})();
