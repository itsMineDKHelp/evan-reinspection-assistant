importScripts('lib/xlsx.full.min.js');

// Orchestrates the bulk run so it survives the popup closing (popups don't stay open) and,
// as best as an MV3 service worker can, survives being briefly killed and restarted mid-run:
// state is persisted to storage after every row and resumed automatically on wake.
//
// Navigating between EvAN screens (typing "bldg <pan>" or "PNOT <pan>" into the search bar and
// clicking Go) is a full page reload, not an in-page AJAX update - it destroys whatever content
// script was running mid-step. So every row is driven as a small state machine of messages, and
// after each navigation-triggering message this file waits for the tab to actually finish
// reloading (polling chrome.tabs.get) before sending the next one, instead of trying to keep a
// single message/response pair alive across the reload.

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

// Waits for the tab to finish a navigation triggered a moment ago. Polls chrome.tabs.get rather
// than chrome.tabs.onUpdated so it also works if the navigation already completed by the time
// this is called (no event race).
async function waitForTabLoaded(tabId, { timeout = 15000, settleMs = 250 } = {}) {
  const start = Date.now();
  let sawLoading = false;
  while (Date.now() - start < timeout) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      throw new Error('EvAN tab was closed.');
    }
    if (tab.status === 'loading') sawLoading = true;
    if (tab.status === 'complete' && sawLoading) {
      await new Promise((r) => setTimeout(r, settleMs));
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Didn't observe a loading->complete transition (maybe it was instant); give it one more
  // settle beat and move on rather than failing the whole row over a timing fluke.
  await new Promise((r) => setTimeout(r, settleMs));
}

// The content script is freshly injected on every page load, but there can be a few ms gap
// between the tab reporting "complete" and the script's listener being registered. Retry a
// handful of times on "Receiving end does not exist" before giving up.
async function sendMessageWithRetry(tabId, message, { retries = 6, delay = 200 } = {}) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError || new Error('sendMessage failed');
}

async function navigateAndWait(tabId, command) {
  try {
    await sendMessageWithRetry(tabId, { type: 'TRIGGER_NAV', command }, { retries: 3, delay: 150 });
  } catch (e) {
    // The port can legitimately die right as navigation starts (bfcache/teardown) - that's
    // expected here, not a failure, as long as the tab actually ends up navigating.
  }
  await waitForTabLoaded(tabId);
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
  runLoop();
  return { total: rows.length, toProcess: rows.filter((r) => r.status === 'pending').length };
}

async function stopRun() {
  if (runState) {
    runState.status = 'stopped';
    await persist();
  }
}

function pushLog(entry) {
  runState.log.push(entry);
  if (runState.log.length > 500) runState.log.shift();
}

async function processOneRow(tabId, row) {
  await navigateAndWait(tabId, `bldg ${row.panSearchId}`);

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

  await navigateAndWait(tabId, `PNOT ${row.panSearchId}`);

  const noteResponse = await sendMessageWithRetry(tabId, { type: 'ADD_PNOT_NOTE', noteText: note });
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
    pushLog(`Skipped PAN ${row.pan}: ${row.reason}`);
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
    pushLog(`Done PAN ${row.pan}: value ${row.value}`);
  } catch (err) {
    row.status = 'error';
    row.reason = String(err && err.message ? err.message : err);
    pushLog(`Error on PAN ${row.pan}: ${row.reason}`);
  }

  runState.index += 1;
  await persist();

  if (runState.status === 'running') {
    setTimeout(runLoop, 50);
  }
}

async function exportResults() {
  const rows = runState.rows.map((r) => ({
    PAN: r.pan,
    Comments: r.reason || '',
    'Chosen Grouping': r.groupingNumber ? `${r.groupingNumber} ${r.groupingLabel}` : '',
    Value: r.value == null ? '' : r.value,
    Status: r.status,
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Results');
  const wbArray = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([wbArray], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url,
    filename: `evan-reinspection-results-${new Date().toISOString().slice(0, 10)}.xlsx`,
    saveAs: false,
  });
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
    }
  })();
  return true;
});
