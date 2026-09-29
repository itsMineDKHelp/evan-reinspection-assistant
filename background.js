importScripts('lib/xlsx.full.min.js');

// Orchestrates the bulk run so it survives the popup closing (popups don't stay open) and,
// as best as an MV3 service worker can, survives being briefly killed and restarted mid-run:
// state is persisted to storage after every row and resumed automatically on wake.
//
// Each row is driven as a small state machine of messages sent to the content script running
// in the EvAN tab (see the Navigation helpers section below for why).

const STORAGE_KEY = 'runState';

let runState = null; // in-memory working copy while a run is active

// --- Text matching for groupings ---------------------------------------------------------

function normalizeLoose(s) {
  // Lowercase, strip accents, drop everything that isn't a letter/digit - so "Mini Home",
  // "mini-home" and "minihome" all collapse to the same string, and French accents don't
  // matter either.
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// True if `needle` appears in `haystack` either as an exact substring, or - for typo tolerance
// on real-world description text - as a substring-length window whose edit distance to needle
// is small. Short keywords get zero fuzz (too easy to false-positive on 3-4 letter words).
function fuzzyIncludes(haystack, needle) {
  if (!needle) return false;
  if (haystack.includes(needle)) return true;

  const maxDist = needle.length <= 4 ? 0 : needle.length <= 7 ? 1 : 2;
  if (maxDist === 0) return false;

  for (let start = 0; start <= haystack.length - (needle.length - maxDist); start++) {
    for (let len = needle.length - maxDist; len <= needle.length + maxDist; len++) {
      if (start + len > haystack.length || len <= 0) continue;
      const window = haystack.substr(start, len);
      if (levenshtein(window, needle) <= maxDist) return true;
    }
  }
  return false;
}

function matchGrouping(description, groupings) {
  const desc = normalizeLoose(description);

  const hits = groupings.filter((g) => g.keyword && fuzzyIncludes(desc, normalizeLoose(g.keyword)));

  // Multiple keyword rows for the same grouping number (e.g. "mini home" and "mobile" both
  // filed under 24) both matching isn't ambiguous - it's the same answer twice.
  const byNumber = new Map();
  for (const hit of hits) {
    if (!byNumber.has(hit.number)) byNumber.set(hit.number, hit);
  }

  if (byNumber.size === 1) return { status: 'ok', grouping: [...byNumber.values()][0] };
  if (byNumber.size === 0) return { status: 'no_match' };
  return { status: 'ambiguous', matches: [...byNumber.values()] };
}

// --- Row parsing ---------------------------------------------------------------------------

function toPanSearchId(panValue) {
  const digits = String(panValue).replace(/\D/g, '');
  return '0' + digits.padStart(7, '0').slice(-7);
}

function parseBuildingCount(cellValue) {
  const s = String(cellValue == null ? '' : cellValue).trim();
  const match = s.match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : null;
}

function normalizeNetCondition(raw) {
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return null;
  if (n > 0 && n <= 1) return Math.round(n * 100);
  return Math.round(n);
}

async function persist() {
  await chrome.storage.local.set({ [STORAGE_KEY]: runState });
}

async function getEvanTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://evan.snb.ca/*' });
  if (tabs.length === 0) throw new Error('No open EvAN tab found. Open EvAN and try again.');
  return tabs[0].id;
}

async function buildRows(sheetRows, columnMap, groupings) {
  const results = [];
  for (const raw of sheetRows) {
    const pan = raw[columnMap.pan];
    if (pan === undefined || pan === null || pan === '') continue;

    const description = raw[columnMap.description] || '';
    const buildingCount = parseBuildingCount(raw[columnMap.buildingCount]);
    const netConditionPercent = normalizeNetCondition(raw[columnMap.netCondition]);

    const row = {
      pan: String(pan),
      panSearchId: toPanSearchId(pan),
      description,
      buildingCount,
      netConditionPercent,
      status: 'pending',
      reason: '',
      groupingNumber: null,
      groupingLabel: '',
      value: null,
      note: '',
    };

    if (buildingCount !== 1) {
      row.status = 'skipped';
      row.reason = buildingCount === 0 || buildingCount === null ? 'vacant land / no building count' : 'multi-building, skipped for now';
      results.push(row);
      continue;
    }

    const match = matchGrouping(description, groupings);
    if (match.status === 'ok') {
      row.groupingNumber = match.grouping.number;
      row.groupingLabel = match.grouping.description;
    } else if (match.status === 'no_match') {
      row.status = 'skipped';
      row.reason = 'no grouping match';
    } else {
      row.status = 'skipped';
      row.reason = 'ambiguous grouping match (' + match.matches.map((m) => m.number).join(', ') + ')';
    }

    results.push(row);
  }
  return results;
}

// --- Navigation helpers ---------------------------------------------------------------------
//
// Navigating (typing a command into the search bar and clicking Go) sometimes triggers a full
// page reload and sometimes an in-page AJAX swap - there's no reliable way to tell which from
// here, and guessing via the tab's browser-level loading status was both slow (it doesn't fire
// for AJAX swaps, so every navigation ate a full timeout doing nothing) and not actually a
// correctness check anyway. So this file doesn't try to detect page-load completion at all: it
// fires the navigation, then immediately starts trying to deliver the next step message,
// retrying through whatever happens next - a full reload kills the current content script and
// a fresh one gets auto-injected (via manifest content_scripts) that the retries eventually
// reach; an AJAX swap keeps the same script alive and it just receives the message once EvAN's
// call finishes. Either way, the step itself (see automation.js) starts by confirming the
// correct PAN actually loaded before touching anything, which is the real correctness guard.

const CONTENT_SCRIPT_FILES = [
  'lib/xlsx.full.min.js',
  'content/fields.js',
  'content/hotkey.js',
  'content/automation.js',
  'content/content.js',
];

// Chrome only auto-runs manifest content_scripts on a page *load* - it never retroactively
// injects into a tab that was already open before the extension was installed/reloaded. If the
// EvAN tab was sitting there from before, nothing is listening until it navigates, so every
// message fails with "Could not establish connection. Receiving end does not exist." This
// checks for that and force-injects the same files by hand when needed. content.js guards
// itself against being loaded twice, so this is safe to call speculatively.
async function ensureContentScriptInjected(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__evanAssistantLoaded,
    });
    if (result) return;
  } catch (e) {
    return; // e.g. tab navigated away mid-check; let the caller's own retries surface any real error
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
  } catch (e) {
    // Same idea - a real failure here will just show up as the message still not going through.
  }
}

// The content script may be mid-teardown (reload in flight) or not yet re-injected on the new
// page. Retry for a while on failure rather than giving up after a couple of tries - a real
// EvAN page load can take a few seconds.
async function sendMessageWithRetry(tabId, message, { retries = 40, delay = 250 } = {}) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (err) {
      lastError = err;
      if (i === 0) await ensureContentScriptInjected(tabId);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError || new Error('sendMessage failed');
}

async function navigate(tabId, command) {
  try {
    await sendMessageWithRetry(tabId, { type: 'TRIGGER_NAV', command }, { retries: 5, delay: 150 });
  } catch (e) {
    // The port can legitimately die right as navigation starts (bfcache/teardown) - that's
    // expected here, not a failure, as long as the tab actually ends up navigating.
  }
}

// --- Run state machine -----------------------------------------------------------------------

async function startRun(sheetRows, columnMap, groupings, inspectorCode) {
  const rows = await buildRows(sheetRows, columnMap, groupings);
  runState = {
    status: 'running',
    rows,
    index: 0,
    inspectorCode,
    startedAt: Date.now(),
    log: [],
  };
  await persist();

  // If the EvAN tab was already open before this extension was loaded/reloaded, nothing is
  // listening in it yet (see ensureContentScriptInjected) - fix that up front instead of
  // letting the first couple of rows fail and recover on their own.
  try {
    const tabId = await getEvanTabId();
    await ensureContentScriptInjected(tabId);
  } catch (e) {
    // No EvAN tab yet, or the tab isn't injectable (e.g. a chrome:// page) - runLoop's own
    // per-row error handling will surface a clear message for that.
  }

  runLoop();
  return { total: rows.length, toProcess: rows.filter((r) => r.status === 'pending').length };
}

async function stopRun() {
  if (runState) {
    runState.status = 'stopped';
    await persist();
  }
}

function pushLog(pan, type, message) {
  const entry = { ts: Date.now(), pan, type, message, text: `${type === 'error' ? 'Error on' : type === 'skipped' ? 'Skipped' : 'Done'} PAN ${pan}: ${message}` };
  runState.log.push(entry);
  if (runState.log.length > 2000) runState.log.shift();
}

async function processOneRow(tabId, row) {
  await navigate(tabId, `bldg ${row.panSearchId}`);

  const fillResponse = await sendMessageWithRetry(tabId, {
    type: 'FILL_AND_SAVE_BUILDING',
    row,
    settings: { inspectorCode: runState.inspectorCode },
  });
  if (!fillResponse || !fillResponse.ok) {
    throw new Error((fillResponse && fillResponse.error) || 'building edit step failed');
  }
  const { value, garageAdded, garagePending } = fillResponse.result;

  let note = `${runState.inspectorCode}, Grouping ${row.groupingNumber} ${row.groupingLabel}, ${row.netConditionPercent}%`;
  if (garageAdded) note += ', added 736';

  await navigate(tabId, `PNOT ${row.panSearchId}`);

  const noteResponse = await sendMessageWithRetry(tabId, {
    type: 'ADD_PNOT_NOTE',
    panSearchId: row.panSearchId,
    noteText: note,
  });
  if (!noteResponse || !noteResponse.ok) {
    throw new Error((noteResponse && noteResponse.error) || 'PNOT note step failed');
  }

  return { value, note, garagePending, noteSubmitted: noteResponse.result.noteSubmitted };
}

async function runLoop() {
  if (!runState || runState.status !== 'running') return;

  if (runState.index >= runState.rows.length) {
    runState.status = 'done';
    await persist();
    await exportResults();
    return;
  }

  const row = runState.rows[runState.index];

  if (row.status !== 'pending') {
    pushLog(row.pan, 'skipped', row.reason);
    runState.index += 1;
    await persist();
    return runLoop();
  }

  try {
    const tabId = await getEvanTabId();
    const result = await processOneRow(tabId, row);

    row.status = 'done';
    row.value = result.value;
    row.note = result.note;
    if (result.garagePending) {
      row.reason = 'pending 736';
    }
    if (!result.noteSubmitted) {
      row.reason = (row.reason ? row.reason + '; ' : '') + 'PNOT note may need manual confirmation';
    }
    pushLog(row.pan, 'done', `value ${row.value}` + (row.reason ? ` (${row.reason})` : ''));
  } catch (err) {
    row.status = 'error';
    row.reason = String(err && err.message ? err.message : err);
    pushLog(row.pan, 'error', row.reason);
  }

  runState.index += 1;
  await persist();

  if (runState.status === 'running') {
    setTimeout(runLoop, 50);
  }
}

// PAN always sits alone in column A on every sheet below so it's a clean VLOOKUP key.

function resultsSheetRows() {
  return runState.rows.map((r) => ({
    PAN: r.pan,
    Comments: r.reason || '',
    'Chosen Grouping': r.groupingNumber ? `${r.groupingNumber} ${r.groupingLabel}` : '',
    Value: r.value == null ? '' : r.value,
    Status: r.status,
  }));
}

function skippedSheetRows() {
  return runState.rows
    .filter((r) => r.status === 'skipped')
    .map((r) => ({
      PAN: r.pan,
      Reason: r.reason || '',
      Description: r.description || '',
      'Building Count': r.buildingCount == null ? '' : r.buildingCount,
    }));
}

function errorsSheetRows() {
  return runState.rows
    .filter((r) => r.status === 'error')
    .map((r) => ({
      PAN: r.pan,
      Error: r.reason || '',
      Description: r.description || '',
    }));
}

function activityLogSheetRows() {
  return runState.log.map((entry) => ({
    PAN: entry.pan,
    Type: entry.type,
    Message: entry.message,
    Time: new Date(entry.ts).toLocaleString(),
  }));
}

function buildWorkbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    if (rows.length === 0) continue;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  }
  return wb;
}

async function downloadWorkbook(wb, filenameSuffix) {
  const wbArray = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([wbArray], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: `evan-reinspection-${filenameSuffix}-${new Date().toISOString().slice(0, 10)}.xlsx`,
    saveAs: false,
  });
}

async function exportResults() {
  const wb = buildWorkbook([
    ['Results', resultsSheetRows()],
    ['Skipped', skippedSheetRows()],
    ['Errors', errorsSheetRows()],
    ['Activity Log', activityLogSheetRows()],
  ]);
  await downloadWorkbook(wb, 'results');
}

async function exportSkippedOnly() {
  const wb = buildWorkbook([['Skipped', skippedSheetRows()]]);
  await downloadWorkbook(wb, 'skipped-only');
}

// Resume an interrupted run if the service worker was killed and restarted mid-run.
chrome.storage.local.get([STORAGE_KEY], (data) => {
  if (data[STORAGE_KEY] && data[STORAGE_KEY].status === 'running') {
    runState = data[STORAGE_KEY];
    runLoop();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'START_RUN') {
      try {
        const summary = await startRun(message.sheetRows, message.columnMap, message.groupings, message.inspectorCode);
        sendResponse({ ok: true, summary });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    } else if (message.type === 'STOP_RUN') {
      await stopRun();
      sendResponse({ ok: true });
    } else if (message.type === 'GET_STATE') {
      sendResponse({ ok: true, state: runState || (await chrome.storage.local.get([STORAGE_KEY]))[STORAGE_KEY] || null });
    } else if (message.type === 'DOWNLOAD_RESULTS') {
      if (runState) {
        await exportResults();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'No run results in memory.' });
      }
    } else if (message.type === 'DOWNLOAD_SKIPPED') {
      if (runState) {
        await exportSkippedOnly();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'No run results in memory.' });
      }
    }
  })();
  return true;
});
