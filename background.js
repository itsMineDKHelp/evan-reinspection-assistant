importScripts('lib/xlsx.full.min.js');

// Orchestrates the bulk run so it survives the popup closing (popups don't stay open) and,
// as best as an MV3 service worker can, survives being briefly killed and restarted mid-run:
// state is persisted to storage after every row and resumed automatically on wake.

const STORAGE_KEY = 'runState';

let runState = null; // in-memory working copy while a run is active

function normalizeText(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function matchGrouping(description, groupings) {
  const desc = normalizeText(description);
  const matches = groupings.filter((g) => g.keyword && desc.includes(normalizeText(g.keyword)));
  if (matches.length === 1) return { status: 'ok', grouping: matches[0] };
  if (matches.length === 0) return { status: 'no_match' };
  return { status: 'ambiguous', matches };
}

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
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'PROCESS_ROW',
      row,
      settings: { inspectorCode: runState.inspectorCode },
    });

    if (!response || !response.ok) {
      row.status = 'error';
      row.reason = (response && response.error) || 'unknown error';
      pushLog(`Error on PAN ${row.pan}: ${row.reason}`);
    } else {
      row.status = 'done';
      row.value = response.result.value;
      row.note = response.result.note;
      if (response.result.pendingGarage736) {
        row.reason = 'pending 736';
      }
      if (!response.result.noteSubmitted) {
        row.reason = (row.reason ? row.reason + '; ' : '') + 'PNOT note may need manual confirmation';
      }
      pushLog(`Done PAN ${row.pan}: value ${row.value}`);
    }
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
