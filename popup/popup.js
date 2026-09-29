let headers = [];
let sheetRows = [];

const el = (id) => document.getElementById(id);

function detectColumn(headers, patterns) {
  for (const pattern of patterns) {
    const exact = headers.find((h) => h.trim().toLowerCase() === pattern);
    if (exact) return exact;
  }
  for (const pattern of patterns) {
    const partial = headers.find((h) => h.toLowerCase().includes(pattern));
    if (partial) return partial;
  }
  return headers[0] || '';
}

function populateSelect(select, headers, selected) {
  select.innerHTML = '';
  for (const h of headers) {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = h;
    if (h === selected) opt.selected = true;
    select.appendChild(opt);
  }
}

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    const wb = XLSX.read(data, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    sheetRows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    headers = sheetRows.length ? Object.keys(sheetRows[0]) : [];

    populateSelect(el('mapPan'), headers, detectColumn(headers, ['pan']));
    populateSelect(el('mapDescription'), headers, detectColumn(headers, ['description', 'descript']));
    populateSelect(el('mapNetCondition'), headers, detectColumn(headers, ['net condition']));
    populateSelect(el('mapBuildingCount'), headers, detectColumn(headers, ['bldg count', 'comments']));

    el('mappingArea').classList.remove('hidden');
    updateStartEnabled();
  };
  reader.readAsArrayBuffer(file);
}

function addGroupingRow(number = '', description = '') {
  const row = document.createElement('div');
  row.className = 'grouping-row';

  const numberInput = document.createElement('input');
  numberInput.type = 'text';
  numberInput.maxLength = 2;
  numberInput.placeholder = '13';
  numberInput.value = number;
  numberInput.className = 'grouping-number';

  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.placeholder = 'residence';
  descInput.title = 'Use as few words as possible, it just needs to match a substring of the description column.';
  descInput.value = description;
  descInput.className = 'grouping-keyword';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = '−';
  removeBtn.addEventListener('click', () => {
    row.remove();
    updateStartEnabled();
  });

  row.appendChild(numberInput);
  row.appendChild(descInput);
  row.appendChild(removeBtn);
  el('groupingRows').appendChild(row);

  numberInput.addEventListener('input', updateStartEnabled);
  descInput.addEventListener('input', updateStartEnabled);
}

function readGroupings() {
  return Array.from(document.querySelectorAll('.grouping-row'))
    .map((row) => ({
      number: row.querySelector('.grouping-number').value.trim(),
      description: row.querySelector('.grouping-keyword').value.trim(),
      keyword: row.querySelector('.grouping-keyword').value.trim(),
    }))
    .filter((g) => g.number && g.description);
}

function updateStartEnabled() {
  const hasInspector = el('inspectorCode').value.trim().length > 0;
  const hasFile = sheetRows.length > 0;
  const hasGroupings = readGroupings().length > 0;
  el('startButton').disabled = !(hasInspector && hasFile && hasGroupings);
}

function renderState(state) {
  if (!state) return;

  const isActive = state.status === 'running';
  el('startButton').classList.toggle('hidden', isActive || state.status === 'done');
  el('stopButton').classList.toggle('hidden', !isActive);
  el('progressSection').classList.remove('hidden');

  const total = state.rows.length;
  const done = state.rows.filter((r) => r.status === 'done' || r.status === 'error' || r.status === 'skipped').length;
  const okCount = state.rows.filter((r) => r.status === 'done').length;
  const skipped = state.rows.filter((r) => r.status === 'skipped').length;
  const errors = state.rows.filter((r) => r.status === 'error').length;

  el('progressSummary').textContent =
    `${done}/${total} processed — ${okCount} done, ${skipped} skipped, ${errors} errors (status: ${state.status})`;

  el('progressLog').textContent = state.log.slice(-40).map((entry) => entry.text || entry).join('\n');
  el('progressLog').scrollTop = el('progressLog').scrollHeight;

  el('downloadButton').classList.toggle('hidden', state.status !== 'done');
  el('downloadSkippedButton').classList.toggle('hidden', state.status !== 'done' || skipped === 0);
}

async function init() {
  const stored = await chrome.storage.local.get(['inspectorCode', 'hotkeyEnabled']);
  if (stored.inspectorCode) el('inspectorCode').value = stored.inspectorCode;
  el('hotkeyEnabled').checked = !!stored.hotkeyEnabled;

  el('inspectorCode').addEventListener('input', () => {
    chrome.storage.local.set({ inspectorCode: el('inspectorCode').value.trim() });
    updateStartEnabled();
  });

  el('hotkeyEnabled').addEventListener('change', () => {
    chrome.storage.local.set({ hotkeyEnabled: el('hotkeyEnabled').checked });
  });

  el('fileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  el('addGroupingRow').addEventListener('click', () => addGroupingRow());
  addGroupingRow();

  el('startButton').addEventListener('click', async () => {
    const columnMap = {
      pan: el('mapPan').value,
      description: el('mapDescription').value,
      netCondition: el('mapNetCondition').value,
      buildingCount: el('mapBuildingCount').value,
    };
    const groupings = readGroupings();
    const inspectorCode = el('inspectorCode').value.trim();

    const response = await chrome.runtime.sendMessage({
      type: 'START_RUN',
      sheetRows,
      columnMap,
      groupings,
      inspectorCode,
    });

    if (!response.ok) {
      alert('Could not start: ' + response.error);
      return;
    }
    el('startButton').classList.add('hidden');
    el('stopButton').classList.remove('hidden');
  });

  el('stopButton').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_RUN' });
  });

  el('downloadButton').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'DOWNLOAD_RESULTS' });
  });

  el('downloadSkippedButton').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'DOWNLOAD_SKIPPED' });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.runState) {
      renderState(changes.runState.newValue);
    }
  });

  const initial = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (initial && initial.ok && initial.state) {
    renderState(initial.state);
  }

  updateStartEnabled();
}

init();
