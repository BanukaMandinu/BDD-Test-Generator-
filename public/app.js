(() => {
  const el = (id) => document.getElementById(id);

  const themeToggle = el('themeToggle');
  const applyTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
  };
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', next); } catch (e) {}
    applyTheme(next);
  });

  const resultsPanel = el('resultsPanel');
  const inputText = el('inputText');
  const generateBtn = el('generateBtn');
  const generateStatus = el('generateStatus');
  const runSelect = el('runSelect');
  const interactiveToggle = el('interactiveToggle');
  const refineToggle = el('refineToggle');
  const sessionToggle = el('sessionToggle');
  const sessionHint = el('sessionHint');
  const sessionSetupToggle = el('sessionSetupToggle');
  const sessionBorrow = el('sessionBorrow');
  const credentialFields = el('credentialFields');
  const extraInstructions = el('extraInstructions');
  const testUsername = el('testUsername');
  const testPassword = el('testPassword');
  const urlGateHint = el('urlGateHint');
  const activityLog = el('activityLog');
  const activityItems = el('activityItems');
  const typeGrid = el('typeGrid');
  const exportToggle = el('exportToggle');
  const exportOptions = el('exportOptions');
  const typeAllBtn = el('typeAllBtn');
  const typeDefaultsBtn = el('typeDefaultsBtn');

  const recordBtn = el('recordBtn');
  const recordPanel = el('recordPanel');
  const recordStatus = el('recordStatus');
  const recordFlowList = el('recordFlowList');
  const generateFromRecordingsBtn = el('generateFromRecordingsBtn');
  const recordCancelBtn = el('recordCancelBtn');
  const recordPanelStatus = el('recordPanelStatus');

  const qualityPanel = el('qualityPanel');
  const qualityTitle = el('qualityTitle');
  const qualityToggle = el('qualityToggle');
  const qualityIssues = el('qualityIssues');
  const refineNotes = el('refineNotes');
  const refineNotesList = el('refineNotesList');

  let testTypes = [];

  const featureTitleInput = el('featureTitle');
  const featureDescriptionInput = el('featureDescription');
  const sourceUrlNote = el('sourceUrlNote');
  const scenarioList = el('scenarioList');
  const addScenarioBtn = el('addScenarioBtn');
  const saveRunBtn = el('saveRunBtn');
  const exportBtn = el('exportBtn');
  const saveStatus = el('saveStatus');

  const bulkReviewInput = el('bulkReviewInput');
  const updateAllBtn = el('updateAllBtn');
  const bulkReviewStatus = el('bulkReviewStatus');
  const bulkActivityLog = el('bulkActivityLog');
  const bulkActivityItems = el('bulkActivityItems');

  const requirementList = el('requirementList');
  const coverageFill = el('coverageFill');
  const coverageLabel = el('coverageLabel');
  const saveCoverageBtn = el('saveCoverageBtn');
  const coverageSaveStatus = el('coverageSaveStatus');

  let currentRun = null;

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Matches a full https?:// URL, or a bare domain typed without a protocol
  // ("learnwithice.com", "www.example.com") — people very often paste just
  // the domain, and treating that as plain text instead of a link was a
  // real usability bug. On its own this shape also matches ordinary dotted
  // identifiers in plain prose ("the config.json file", "check order.total")
  // — isPlausibleDomain() below guards against that. Mirrors URL_PATTERN /
  // COMMON_TLDS / isPlausibleDomain in server/lib/claudeCli.js.
  const URL_PATTERN = /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s]*)?/i;
  const COMMON_TLDS = new Set([
    'com', 'org', 'net', 'io', 'dev', 'app', 'co', 'edu', 'gov', 'mil', 'info',
    'biz', 'me', 'ai', 'xyz', 'tv', 'tech', 'online', 'site', 'store', 'shop',
    'blog', 'cloud', 'page', 'run', 'top', 'live', 'work', 'world', 'agency',
    'company', 'team', 'digital', 'name', 'pro', 'club', 'design', 'studio',
    'uk', 'us', 'ca', 'au', 'nz', 'de', 'fr', 'es', 'it', 'nl', 'se', 'no',
    'dk', 'fi', 'pl', 'ru', 'jp', 'cn', 'in', 'br', 'mx', 'ie', 'ch', 'at',
    'be', 'pt', 'gr', 'cz', 'sg', 'hk', 'kr', 'za', 'id', 'ph', 'th', 'vn',
  ]);

  function isPlausibleDomain(candidate) {
    if (/^https?:\/\//i.test(candidate) || /^www\./i.test(candidate)) return true;
    const host = candidate.split('/')[0];
    const tld = host.split('.').pop().toLowerCase();
    return COMMON_TLDS.has(tld);
  }

  function extractUrl(text) {
    const match = text.trim().match(URL_PATTERN);
    if (!match || !isPlausibleDomain(match[0])) return null;
    return /^https?:\/\//i.test(match[0]) ? match[0] : `https://${match[0]}`;
  }

  // Replaces window.confirm() with an in-app dialog matching the rest of the
  // UI, instead of the browser's own "localhost:4173 says" popup. One shared
  // overlay, reused for every call — resolves true/false like confirm() did.
  const confirmOverlay = el('confirmOverlay');
  const confirmMessage = el('confirmMessage');
  const confirmOkBtn = el('confirmOkBtn');
  const confirmCancelBtn = el('confirmCancelBtn');

  function customConfirm(message, { okLabel = 'OK', danger = false } = {}) {
    return new Promise((resolve) => {
      confirmMessage.textContent = message;
      confirmOkBtn.textContent = okLabel;
      confirmOkBtn.className = danger ? 'danger-outline' : 'primary';
      confirmOverlay.classList.remove('hidden');

      function cleanup(result) {
        confirmOverlay.classList.add('hidden');
        confirmOkBtn.removeEventListener('click', onOk);
        confirmCancelBtn.removeEventListener('click', onCancel);
        confirmOverlay.removeEventListener('click', onOverlay);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onOverlay(e) { if (e.target === confirmOverlay) cleanup(false); }
      function onKey(e) { if (e.key === 'Escape') cleanup(false); }

      confirmOkBtn.addEventListener('click', onOk);
      confirmCancelBtn.addEventListener('click', onCancel);
      confirmOverlay.addEventListener('click', onOverlay);
      document.addEventListener('keydown', onKey);
    });
  }

  async function api(path, options = {}) {
    const res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  // Toggles only the state classes — replacing className here would strip the
  // identifying class (e.g. scenario-status) and orphan the node.
  function setStatus(node, message, kind) {
    if (!node) return;
    node.textContent = message;
    node.classList.remove('error', 'ok');
    if (kind) node.classList.add(kind);
    if (message) setTimeout(() => { if (node.textContent === message) node.textContent = ''; }, 4000);
  }

  // ---------- Tabs ----------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      el(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // ---------- Import a shared file ----------
  const importZone = el('importZone');
  const importFile = el('importFile');
  const importBtn = el('importBtn');
  const importStatus = el('importStatus');
  const importWarnings = el('importWarnings');

  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

  async function importFileContents(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setStatus(importStatus, 'That file is too large (limit 2 MB).', 'error');
      return;
    }

    importWarnings.classList.add('hidden');
    importWarnings.innerHTML = '';
    setStatus(importStatus, `Reading ${file.name}…`);

    try {
      const content = await file.text();
      const { run, warnings } = await api('/import', {
        method: 'POST',
        body: JSON.stringify({ content, filename: file.name }),
      });

      currentRun = run;
      setStatus(importStatus, `Imported ${run.scenarios.length} test case${run.scenarios.length === 1 ? '' : 's'}.`, 'ok');

      if (warnings?.length) {
        importWarnings.innerHTML = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
        importWarnings.classList.remove('hidden');
      }

      await loadRunList(run.id);
      showRun();
      resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setStatus(importStatus, err.message, 'error');
    } finally {
      importFile.value = ''; // allow re-picking the same file
    }
  }

  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => importFileContents(importFile.files[0]));

  ['dragenter', 'dragover'].forEach((evt) =>
    importZone.addEventListener(evt, (e) => {
      e.preventDefault();
      importZone.classList.add('dragging');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    importZone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'dragleave' && importZone.contains(e.relatedTarget)) return;
      importZone.classList.remove('dragging');
    })
  );
  importZone.addEventListener('drop', (e) => importFileContents(e.dataTransfer?.files?.[0]));

  // ---------- Product-info file upload (extracts text into Extra instructions) ----------
  const productInfoZone = el('productInfoZone');
  const productInfoFile = el('productInfoFile');
  const productInfoBtn = el('productInfoBtn');
  const productInfoStatus = el('productInfoStatus');
  const productInfoWarnings = el('productInfoWarnings');

  const MAX_PRODUCT_INFO_BYTES = 2 * 1024 * 1024;

  // Reads as a data: URL rather than building base64 by hand — safe for large
  // binary files without hitting a call-stack limit on the conversion.
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  async function uploadProductInfo(file) {
    if (!file) return;
    if (file.size > MAX_PRODUCT_INFO_BYTES) {
      setStatus(productInfoStatus, 'That file is too large (limit 2 MB).', 'error');
      return;
    }

    productInfoWarnings.classList.add('hidden');
    productInfoWarnings.innerHTML = '';
    setStatus(productInfoStatus, `Reading ${file.name}…`);

    try {
      const content = await fileToBase64(file);
      const { text, warnings, filename } = await api('/product-info', {
        method: 'POST',
        body: JSON.stringify({ content, filename: file.name }),
      });

      const section = `## Product info from ${filename}\n\n${text}`;
      extraInstructions.value = extraInstructions.value.trim()
        ? `${extraInstructions.value.trim()}\n\n${section}`
        : section;

      setStatus(productInfoStatus, `Added ${text.length.toLocaleString()} characters from ${filename} to Extra instructions.`, 'ok');

      if (warnings?.length) {
        productInfoWarnings.innerHTML = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
        productInfoWarnings.classList.remove('hidden');
      }
    } catch (err) {
      setStatus(productInfoStatus, err.message, 'error');
    } finally {
      productInfoFile.value = '';
    }
  }

  productInfoBtn.addEventListener('click', () => productInfoFile.click());
  productInfoFile.addEventListener('change', () => uploadProductInfo(productInfoFile.files[0]));

  ['dragenter', 'dragover'].forEach((evt) =>
    productInfoZone.addEventListener(evt, (e) => {
      e.preventDefault();
      productInfoZone.classList.add('dragging');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    productInfoZone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'dragleave' && productInfoZone.contains(e.relatedTarget)) return;
      productInfoZone.classList.remove('dragging');
    })
  );
  productInfoZone.addEventListener('drop', (e) => uploadProductInfo(e.dataTransfer?.files?.[0]));

  // ---------- Multi-page discovery ----------
  const discoverBtn = el('discoverBtn');
  const pagePicker = el('pagePicker');
  const pageList = el('pageList');
  const pagePickerStatus = el('pagePickerStatus');
  const generateFromPagesBtn = el('generateFromPagesBtn');

  let discoveredPages = [];

  function renderPageList() {
    pageList.innerHTML = discoveredPages.map((p, i) => `
      <label class="page-item ${p.selected ? 'on' : ''}" data-index="${i}">
        <input type="checkbox" ${p.selected ? 'checked' : ''} />
        <span class="page-item-body">
          <span class="page-item-title">${escapeHtml(p.title)}</span>
          <span class="page-item-url">${escapeHtml(p.url)}</span>
          ${p.purpose ? `<span class="page-item-purpose">${escapeHtml(p.purpose)}</span>` : ''}
          ${(p.hasForm || p.requiresLogin) ? `
            <span class="page-flags">
              ${p.hasForm ? '<span class="page-flag form">has a form</span>' : ''}
              ${p.requiresLogin ? '<span class="page-flag login">needs sign-in</span>' : ''}
            </span>` : ''}
        </span>
      </label>
    `).join('');
    updatePageCount();
  }

  function updatePageCount() {
    const n = discoveredPages.filter((p) => p.selected).length;
    generateFromPagesBtn.textContent = n
      ? `Generate for ${n} selected page${n === 1 ? '' : 's'}`
      : 'Generate for selected pages';
    generateFromPagesBtn.disabled = n === 0;
  }

  pageList.addEventListener('change', (e) => {
    const item = e.target.closest('.page-item');
    if (!item) return;
    discoveredPages[Number(item.dataset.index)].selected = e.target.checked;
    item.classList.toggle('on', e.target.checked);
    updatePageCount();
  });

  const setAllPages = (fn) => {
    discoveredPages.forEach((p, i) => { p.selected = fn(p, i); });
    renderPageList();
  };
  el('pagesAllBtn').addEventListener('click', () => setAllPages(() => true));
  el('pagesNoneBtn').addEventListener('click', () => setAllPages(() => false));
  el('pagesFormsBtn').addEventListener('click', () => setAllPages((p) => p.hasForm));

  discoverBtn.addEventListener('click', async () => {
    const url = extractUrl(inputText.value);
    if (!url) {
      setStatus(generateStatus, 'Paste a link to the site first — exploring needs a URL.', 'error');
      return;
    }

    discoverBtn.disabled = true;
    generateBtn.disabled = true;
    recordBtn.disabled = true;
    pagePicker.classList.add('hidden');
    setStatus(generateStatus, 'Exploring…');
    generateLog.reset();

    try {
      const res = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, useSession: sessionToggle.checked }),
      });

      await consumeSse(res, {
        onProgress: (p) => generateLog.log(p.message),
        onDone: async (result) => {
          // Pre-tick the pages worth testing: anything with a form, or all of
          // them when the site has none.
          const anyForm = result.pages.some((p) => p.hasForm);
          discoveredPages = result.pages.map((p) => ({ ...p, selected: anyForm ? p.hasForm : true }));
          generateLog.log(`Found ${result.pages.length} pages`, 'done');
          renderPageList();
          pagePicker.classList.remove('hidden');
          setStatus(generateStatus, '', null);
          pagePicker.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
        onFailed: (p) => {
          generateLog.log(p.error, 'failed');
          setStatus(generateStatus, p.error, 'error');
        },
      });
    } catch (err) {
      generateLog.log(err.message, 'failed');
      setStatus(generateStatus, err.message, 'error');
    } finally {
      discoverBtn.disabled = false;
      generateBtn.disabled = false;
      recordBtn.disabled = false;
    }
  });

  generateFromPagesBtn.addEventListener('click', () => {
    const chosen = discoveredPages.filter((p) => p.selected);
    if (!chosen.length) {
      setStatus(pagePickerStatus, 'Tick at least one page.', 'error');
      return;
    }
    runGeneration({ pages: chosen.map(({ url, title, purpose }) => ({ url, title, purpose })) });
  });

  // ---------- Record a flow: a human drives a real browser, we transcribe it ----------
  let recordingSessionId = null;
  let recordPollTimer = null;
  let recordFlowSummaries = [];
  let currentFlowCount = 0;
  const CURRENT_FLOW_ID = '__current';
  // Set only when "Record a flow instead" was clicked from one specific draft
  // scenario's own footer — null means a plain top-level recording (either a
  // brand new run, or "add more flows" to the run already on screen).
  let recordTargetScenarioId = null;

  // The model never touches a browser for this path, so the interactive/
  // credential controls (which are about the MODEL's own exploration) don't
  // apply — lock them while a recording is in flight rather than leave them
  // implying something they won't do. "Use a signed-in session" stays live:
  // it still decides whether the recording window itself opens signed in.
  function setRecordingUiLock(locked) {
    interactiveToggle.disabled = locked;
    if (locked) {
      interactiveToggle.checked = false;
      updateCredentialFieldsVisibility();
    }
  }

  // Mirrors describeAction() in server/lib/prompts.js — this is purely for
  // showing the user what was captured, in the same words Claude will see.
  function describeRecordedAction(a) {
    const name = a.name ? `"${a.name}"` : 'an element';
    const role = a.role ? ` (${a.role})` : '';
    switch (a.type) {
      case 'navigate': return `Navigated to ${a.url}`;
      case 'click': return `Clicked ${name}${role}`;
      case 'submit': return `Submitted the ${name} form`;
      case 'fill': return a.sensitive ? `Typed into ${name}${role} — value not recorded` : `Entered "${a.value ?? ''}" into ${name}${role}`;
      case 'select': return `Chose "${a.value ?? ''}" in ${name}${role}`;
      case 'check': return `${a.checked ? 'Checked' : 'Unchecked'} ${name}${role}`;
      case 'upload': return `Chose file(s) for ${name}`;
      case 'drop': return `Dropped something onto ${name}${role}`;
      case 'assert-visible': return `Confirmed ${name}${role} is visible`;
      case 'assert-text': return a.sensitive ? `Confirmed the text of ${name}${role} — value not recorded` : `Confirmed ${name}${role} shows "${a.value ?? ''}"`;
      case 'assert-value': return a.sensitive ? `Confirmed the value of ${name}${role} — value not recorded` : `Confirmed ${name}${role} has the value "${a.value ?? ''}"`;
      case 'assert-snapshot': return `Confirmed the structure of ${name}${role}`;
      default: return `(${a.type})`;
    }
  }

  // Only one flow's steps shown at a time — simplest, and mirrors how the
  // page picker never shows more than one thing expanded either.
  let expandedFlowId = null;
  let expandedFlowActions = null;

  function renderRecordFlowList() {
    // The flow still being recorded (not yet "Save test"-ed) — shown first, and
    // separately from saved flows, so forgetting what's been clicked so far
    // doesn't mean losing track of it until it's checkpointed.
    const currentRow = currentFlowCount > 0 ? `
      <div class="page-item in-progress" data-flow-id="${CURRENT_FLOW_ID}">
        <span class="page-item-body">
          <span class="page-item-title">Recording now…</span>
          <span class="page-item-url">${currentFlowCount} action${currentFlowCount === 1 ? '' : 's'} so far — click to view</span>
          ${expandedFlowId === CURRENT_FLOW_ID ? `
            <ol class="record-steps">
              ${(expandedFlowActions || []).map((a) => `<li>${escapeHtml(describeRecordedAction(a))}</li>`).join('') || '<li>No actions recorded.</li>'}
            </ol>` : ''}
        </span>
      </div>` : '';
    const savedRows = recordFlowSummaries.map((f) => `
      <div class="page-item" data-flow-id="${escapeHtml(f.id)}">
        <span class="page-item-body">
          <span class="page-item-title">${escapeHtml(f.title)}</span>
          <span class="page-item-url">${f.actionCount} action${f.actionCount === 1 ? '' : 's'} recorded — click to view</span>
          ${f.id === expandedFlowId ? `
            <ol class="record-steps">
              ${(expandedFlowActions || []).map((a) => `<li>${escapeHtml(describeRecordedAction(a))}</li>`).join('') || '<li>No actions recorded.</li>'}
            </ol>` : ''}
        </span>
        <button class="link-btn discard-flow" data-flow-id="${escapeHtml(f.id)}">discard</button>
      </div>
    `).join('');
    recordFlowList.innerHTML = currentRow + savedRows ||
      '<p class="muted-text">No test saved yet — click "Save test" in the browser overlay once you\'ve recorded one.</p>';
    generateFromRecordingsBtn.disabled = recordFlowSummaries.length === 0;
    const verb = currentRun ? 'Add' : 'Generate from';
    generateFromRecordingsBtn.textContent = recordFlowSummaries.length
      ? `${verb} ${recordFlowSummaries.length} recorded test${recordFlowSummaries.length === 1 ? '' : 's'}`
      : 'Generate from recordings';
  }

  recordFlowList.addEventListener('click', async (e) => {
    const discardBtn = e.target.closest('.discard-flow');
    if (discardBtn) {
      if (!recordingSessionId) return;
      try {
        const result = await api(`/record/${recordingSessionId}/flows/${discardBtn.dataset.flowId}`, { method: 'DELETE' });
        recordFlowSummaries = result.savedFlows;
        if (expandedFlowId === discardBtn.dataset.flowId) { expandedFlowId = null; expandedFlowActions = null; }
        renderRecordFlowList();
      } catch (err) {
        setStatus(recordPanelStatus, err.message, 'error');
      }
      return;
    }

    const row = e.target.closest('.page-item');
    if (!row || !recordingSessionId) return;
    const flowId = row.dataset.flowId;
    if (expandedFlowId === flowId) {
      expandedFlowId = null;
      expandedFlowActions = null;
      renderRecordFlowList();
      return;
    }
    try {
      const flow = flowId === CURRENT_FLOW_ID
        ? await api(`/record/${recordingSessionId}/current`)
        : await api(`/record/${recordingSessionId}/flows/${flowId}`);
      expandedFlowId = flowId;
      expandedFlowActions = flow.actions;
      renderRecordFlowList();
    } catch (err) {
      setStatus(recordPanelStatus, err.message, 'error');
    }
  });

  function stopRecordPolling() {
    if (recordPollTimer) clearInterval(recordPollTimer);
    recordPollTimer = null;
  }

  function endRecordingUi() {
    stopRecordPolling();
    recordingSessionId = null;
    recordTargetScenarioId = null;
    currentFlowCount = 0;
    expandedFlowId = null;
    expandedFlowActions = null;
    recordPanel.classList.add('hidden');
    setRecordingUiLock(false);
    // Not a flat `= false` — a bare URL still needs Explore/Record, not
    // Generate, even after an unrelated recording session just ended.
    updateUrlGate();
    discoverBtn.disabled = false;
    recordBtn.disabled = false;
  }

  function startRecordPolling(sessionId) {
    stopRecordPolling();
    recordPollTimer = setInterval(async () => {
      let result;
      try {
        result = await api(`/record/${sessionId}/status`);
      } catch {
        // The session is gone (server restart, or it was never really there) —
        // stop polling but leave whatever was already saved visible.
        stopRecordPolling();
        setStatus(recordPanelStatus, 'That recording session was lost — start again if you need more tests.', 'error');
        return;
      }
      recordFlowSummaries = result.savedFlows;
      currentFlowCount = result.currentFlowActionCount;
      // Keep an open "Recording now…" view live rather than making the user
      // re-click it after every action to see what's new.
      if (expandedFlowId === CURRENT_FLOW_ID) {
        try {
          const flow = await api(`/record/${sessionId}/current`);
          expandedFlowActions = flow.actions;
        } catch {
          // Leave the last-known actions showing rather than blanking the view.
        }
      }
      renderRecordFlowList();
      if (result.closed) {
        // Don't call endRecordingUi() here — that would also hide the panel
        // and drop recordingSessionId, losing the ability to still click
        // "Generate from recordings" or "Discard session" for whatever was
        // already saved before the window closed. Just stop treating the
        // rest of the app as locked out because a session happens to be open.
        recordStatus.textContent = 'Browser window closed — you can still generate from what was saved, or discard it, below.';
        currentFlowCount = 0;
        if (expandedFlowId === CURRENT_FLOW_ID) { expandedFlowId = null; expandedFlowActions = null; }
        renderRecordFlowList();
        stopRecordPolling();
        setRecordingUiLock(false);
        updateUrlGate();
        discoverBtn.disabled = false;
        recordBtn.disabled = false;
      }
    }, 1500);
  }

  // Shared by the top-level "Record a flow" button (a brand new run, or
  // adding more flows to the run already on screen) and a specific draft
  // scenario's "Record a flow instead" button (fromScenarioId set).
  async function startRecording(url, { fromScenarioId = null } = {}) {
    recordBtn.disabled = true;
    generateBtn.disabled = true;
    discoverBtn.disabled = true;
    pagePicker.classList.add('hidden');
    setStatus(generateStatus, 'Opening a browser…');

    try {
      // Recording is manual, hands-on-keyboard work — almost always you'd
      // rather it open already signed in, so this always asks for the saved
      // session (harmless when none is saved; recorder.js falls back to a
      // bare context).
      const result = await api('/record/start', {
        method: 'POST',
        body: JSON.stringify({ url, useSession: true }),
      });
      recordingSessionId = result.sessionId;
      recordTargetScenarioId = fromScenarioId;
      recordFlowSummaries = [];
      currentFlowCount = 0;
      expandedFlowId = null;
      expandedFlowActions = null;
      setRecordingUiLock(true);
      recordStatus.textContent = fromScenarioId
        ? 'A browser window is open — demonstrate this one test case, then Save test in its overlay.'
        : 'A browser window is open — click through your test, then Save test in its overlay.';
      renderRecordFlowList();
      recordPanel.classList.remove('hidden');
      setStatus(generateStatus, '', null);
      recordPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      startRecordPolling(recordingSessionId);
    } catch (err) {
      setStatus(generateStatus, err.message, 'error');
      updateUrlGate();
      discoverBtn.disabled = false;
      recordBtn.disabled = false;
    }
  }

  recordBtn.addEventListener('click', () => {
    if (recordingSessionId) {
      setStatus(generateStatus, 'A recording session is already open — finish or discard it above first.', 'error');
      return;
    }
    const url = extractUrl(inputText.value) || currentRun?.sourceUrl || null;
    if (!url) {
      setStatus(generateStatus, 'Paste a link to the site first — recording needs a URL.', 'error');
      return;
    }
    startRecording(url);
  });

  generateFromRecordingsBtn.addEventListener('click', async () => {
    if (!recordingSessionId) return;
    generateFromRecordingsBtn.disabled = true;
    setStatus(recordPanelStatus, 'Finishing the recording…');
    try {
      const { flows } = await api(`/record/${recordingSessionId}/stop`, { method: 'POST' });
      if (!flows.length) {
        setStatus(recordPanelStatus, 'Nothing was saved — record at least one test first.', 'error');
        generateFromRecordingsBtn.disabled = false;
        return;
      }
      const recordings = flows.map(({ title, startUrl, actions }) => ({ title, startUrl, actions }));
      const targetScenarioId = recordTargetScenarioId;
      endRecordingUi();
      if (currentRun) {
        await appendScenariosFromRecordings(recordings, targetScenarioId);
      } else {
        runGeneration({ recordings });
      }
    } catch (err) {
      setStatus(recordPanelStatus, err.message, 'error');
      generateFromRecordingsBtn.disabled = false;
    }
  });

  // Adds scenarios to the run already on screen from newly recorded flows,
  // instead of runGeneration()'s "always a brand new run" — used once a run
  // already exists, whether that's "record more flows" from the results view
  // or "record a flow instead" filling in one specific draft scenario. Locks
  // the same buttons runGeneration() does, for the same reason: this is an SSE
  // call that can take a while, and currentRun must not be swapped out from
  // under it by an unrelated Generate/Explore/Record/Update-all firing meanwhile.
  async function appendScenariosFromRecordings(recordings, targetScenarioId) {
    setStatus(generateStatus, 'Writing test cases from the recording…');
    generateLog.reset();
    generateBtn.disabled = true;
    discoverBtn.disabled = true;
    recordBtn.disabled = true;
    try {
      const res = await fetch(`/api/runs/${currentRun.id}/scenarios/from-recordings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordings, ...(targetScenarioId ? { scenarioId: targetScenarioId } : {}) }),
      });

      await consumeSse(res, {
        onProgress: (p) => generateLog.log(p.message),
        onDone: async (run) => {
          generateLog.log('Done', 'done');
          currentRun = run;
          setStatus(generateStatus, 'Done.', 'ok');
          showRun();
        },
        onFailed: (p) => {
          generateLog.log(p.error, 'failed');
          setStatus(generateStatus, p.error, 'error');
        },
      });
    } catch (err) {
      generateLog.log(err.message, 'failed');
      setStatus(generateStatus, err.message, 'error');
    } finally {
      updateUrlGate();
      discoverBtn.disabled = false;
      recordBtn.disabled = false;
    }
  }

  recordCancelBtn.addEventListener('click', async () => {
    if (!recordingSessionId) { endRecordingUi(); return; }
    try {
      await api(`/record/${recordingSessionId}/stop`, { method: 'POST' });
    } catch {
      // Already gone — nothing left to clean up.
    }
    endRecordingUi();
  });

  // ---------- Test type picker ----------
  function renderTypeGrid(selectedIds) {
    typeGrid.innerHTML = testTypes.map((t) => {
      const on = selectedIds.includes(t.id);
      return `
        <label class="type-item ${on ? 'on' : ''}" data-type-id="${t.id}">
          <input type="checkbox" ${on ? 'checked' : ''} />
          <span>
            <span class="type-item-label">${escapeHtml(t.label)}</span>
            <span class="type-item-blurb">${escapeHtml(t.blurb)}</span>
          </span>
        </label>
      `;
    }).join('');
  }

  function selectedTypeIds() {
    return [...typeGrid.querySelectorAll('.type-item')]
      .filter((item) => item.querySelector('input').checked)
      .map((item) => item.dataset.typeId);
  }

  typeGrid.addEventListener('change', (e) => {
    const item = e.target.closest('.type-item');
    if (item) item.classList.toggle('on', e.target.checked);
  });

  function setTypes(ids) {
    renderTypeGrid(ids);
  }

  typeAllBtn.addEventListener('click', () => setTypes(testTypes.map((t) => t.id)));
  typeDefaultsBtn.addEventListener('click', () =>
    setTypes(testTypes.filter((t) => t.default).map((t) => t.id))
  );

  // ---------- Borrow a signed-in session from the user's own browser ----------
  const sessionCopyBtn = el('sessionCopyBtn');
  const sessionCopyStatus = el('sessionCopyStatus');
  const sessionPaste = el('sessionPaste');
  const sessionSaveBtn = el('sessionSaveBtn');
  const sessionSaveStatus = el('sessionSaveStatus');
  const sessionWarnings = el('sessionWarnings');
  const sessionClearBtn = el('sessionClearBtn');

  sessionCopyBtn.addEventListener('click', async () => {
    try {
      const { snippet } = await api('/session/snippet');
      await navigator.clipboard.writeText(snippet);
      setStatus(sessionCopyStatus, 'Copied — paste it into the Chrome console.', 'ok');
    } catch (err) {
      // Clipboard access can be refused (insecure context, permissions). Fall
      // back to showing the snippet so the step is never a dead end.
      try {
        const { snippet } = await api('/session/snippet');
        sessionPaste.value = snippet;
        sessionPaste.select();
        setStatus(sessionCopyStatus, 'Could not reach the clipboard — copy it from the box below, then clear it and paste your session back.', 'error');
      } catch (inner) {
        setStatus(sessionCopyStatus, inner.message, 'error');
      }
    }
  });

  sessionSaveBtn.addEventListener('click', async () => {
    const session = sessionPaste.value.trim();
    if (!session) {
      setStatus(sessionSaveStatus, 'Paste the session first.', 'error');
      return;
    }

    sessionSaveBtn.disabled = true;
    sessionWarnings.classList.add('hidden');
    setStatus(sessionSaveStatus, 'Saving…');

    try {
      const result = await api('/session/paste', {
        method: 'POST',
        body: JSON.stringify({ session }),
      });

      sessionPaste.value = '';
      sessionToggle.checked = true; // saving one is a clear signal they want to use it
      setStatus(
        sessionSaveStatus,
        `Saved ${result.cookieCount} cookie${result.cookieCount === 1 ? '' : 's'} and ${result.localStorageCount} stored value${result.localStorageCount === 1 ? '' : 's'}.`,
        'ok'
      );

      if (result.warnings?.length) {
        sessionWarnings.innerHTML = result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
        sessionWarnings.classList.remove('hidden');
      }
      await loadSessionState();
    } catch (err) {
      setStatus(sessionSaveStatus, err.message, 'error');
    } finally {
      sessionSaveBtn.disabled = false;
    }
  });

  sessionClearBtn.addEventListener('click', async () => {
    if (!(await customConfirm('Forget the saved browser session?', { okLabel: 'Forget', danger: true }))) return;
    try {
      await api('/session', { method: 'DELETE' });
      sessionToggle.checked = false;
      sessionWarnings.classList.add('hidden');
      setStatus(sessionSaveStatus, 'Session forgotten.', 'ok');
      await loadSessionState();
    } catch (err) {
      setStatus(sessionSaveStatus, err.message, 'error');
    }
  });

  async function loadSessionState() {
    try {
      const { available, pasted } = await api('/session');

      if (pasted?.available) {
        sessionHint.textContent = `saved from ${pasted.origin || 'your browser'}`;
      } else if (available) {
        sessionHint.textContent = 'saved sign-in found';
      } else {
        sessionHint.textContent = 'for pages behind login';
      }

      sessionHint.classList.toggle('session-ready', available);
      sessionClearBtn.classList.toggle('hidden', !pasted?.available);
    } catch {
      // Non-fatal: the checkbox still works, the hint just stays generic.
    }
  }

  async function loadTestTypes() {
    testTypes = await api('/test-types');
    setTypes(testTypes.filter((t) => t.default).map((t) => t.id));
  }

  // ---------- Quality panel ----------
  const ISSUE_ORDER = ['outline', 'duplicate', 'cucumber', 'reuse', 'uncovered-requirement', 'missing-type', 'language'];

  // Step reuse is the number a QA lead actually cares about: how many step
  // definitions the team will have to write and maintain for this suite.
  function metricsHtml(metrics) {
    if (!metrics || !metrics.totalSteps) return '';
    const { totalSteps, uniqueSteps, reuseRatio } = metrics;
    const verdict = reuseRatio >= 2 ? 'good reuse'
      : reuseRatio >= 1.4 ? 'some reuse'
      : 'almost no reuse — nearly every step needs its own definition';
    return `
      <li class="quality-metrics">
        <span><b>${totalSteps}</b> steps</span>
        <span><b>${uniqueSteps}</b> step definitions needed</span>
        <span><b>${reuseRatio}×</b> reuse — ${escapeHtml(verdict)}</span>
      </li>
    `;
  }

  function renderQuality() {
    const report = currentRun.quality;
    if (!report || !report.issues) {
      qualityPanel.classList.add('hidden');
      return;
    }

    qualityPanel.classList.remove('hidden');
    const { issues } = report;

    if (!issues.length) {
      qualityPanel.classList.add('clean');
      qualityTitle.textContent = 'Quality check: nothing flagged';
      const m = metricsHtml(report.metrics);
      qualityIssues.innerHTML = m;
      qualityToggle.classList.toggle('hidden', !m);
      qualityIssues.classList.add('hidden');
      return;
    }

    qualityPanel.classList.remove('clean');
    qualityToggle.classList.remove('hidden');

    const c = report.counts || {};
    const parts = [];
    if (c.outline) parts.push(`${c.outline} outline issue${c.outline === 1 ? '' : 's'}`);
    if (c.duplicate) parts.push(`${c.duplicate} possible duplicate${c.duplicate === 1 ? '' : 's'}`);
    if (c.cucumber) parts.push(`${c.cucumber} Cucumber issue${c.cucumber === 1 ? '' : 's'}`);
    if (c.reuse) parts.push(`${c.reuse} step-reuse note${c.reuse === 1 ? '' : 's'}`);
    if (c['uncovered-requirement']) parts.push(`${c['uncovered-requirement']} uncovered requirement${c['uncovered-requirement'] === 1 ? '' : 's'}`);
    if (c['missing-type']) parts.push(`${c['missing-type']} requested type${c['missing-type'] === 1 ? '' : 's'} missing`);
    if (c.language) parts.push(`${c.language} wording note${c.language === 1 ? '' : 's'}`);
    qualityTitle.textContent = `Quality check: ${parts.join(', ')}`;

    const sorted = [...issues].sort(
      (a, b) => ISSUE_ORDER.indexOf(a.kind) - ISSUE_ORDER.indexOf(b.kind)
    );
    qualityIssues.innerHTML = sorted
      .map((i) => `<li class="${i.kind}${i.severity === 'error' ? ' severity-error' : ''}">${escapeHtml(i.message)}</li>`)
      .join('') + metricsHtml(report.metrics);
  }

  qualityToggle.addEventListener('click', () => {
    const hidden = qualityIssues.classList.toggle('hidden');
    qualityToggle.textContent = hidden ? 'show' : 'hide';
  });

  function renderRefineNotes() {
    const fixes = currentRun.refineFixes || [];
    if (!fixes.length) {
      refineNotes.classList.add('hidden');
      return;
    }
    refineNotes.classList.remove('hidden');
    refineNotesList.innerHTML = fixes.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
  }

  // ---------- History & diff ----------
  const versionSelect = el('versionSelect');
  const diffPanel = el('diffPanel');
  const diffSummary = el('diffSummary');

  async function loadVersions() {
    try {
      const list = await api(`/runs/${currentRun.id}/versions`);
      versionSelect.innerHTML = '<option value="">— current only —</option>' +
        list.map((v) =>
          `<option value="${v.versionId}">${escapeHtml(v.action)} · ${new Date(v.at).toLocaleTimeString()} (${v.scenarioCount} cases)</option>`
        ).join('');
      versionSelect.disabled = !list.length;
      diffPanel.classList.add('hidden');
      diffSummary.textContent = list.length ? '' : 'no earlier versions yet';
    } catch {
      versionSelect.disabled = true;
    }
  }

  function diffList(items, cls, render) {
    if (!items.length) return '';
    return `<ul>${items.map((i) => `<li class="${cls}">${render(i)}</li>`).join('')}</ul>`;
  }

  function renderDiff(d) {
    if (d.isEmpty) {
      diffPanel.innerHTML = '<div class="diff-group-head">No differences from that version.</div>';
      diffPanel.classList.remove('hidden');
      return;
    }

    const blocks = [];

    if (d.featureTitleChanged) {
      blocks.push(`<div class="diff-group"><div class="diff-group-head">Feature title</div>
        <ul><li class="diff-line-mod"><span class="diff-old">${escapeHtml(d.featureTitleChanged.before)}</span> → ${escapeHtml(d.featureTitleChanged.after)}</li></ul></div>`);
    }

    if (d.added.length) {
      blocks.push(`<div class="diff-group"><div class="diff-group-head">Added (${d.added.length})</div>
        ${diffList(d.added, 'diff-line-add', (s) => `${escapeHtml(s.title)} <span class="hint">(${s.stepCount} steps)</span>`)}</div>`);
    }

    if (d.removed.length) {
      blocks.push(`<div class="diff-group"><div class="diff-group-head">Removed (${d.removed.length})</div>
        ${diffList(d.removed, 'diff-line-del', (s) => escapeHtml(s.title))}</div>`);
    }

    if (d.changed.length) {
      const rows = d.changed.map((c) => {
        const parts = [];
        if (c.titleBefore) {
          parts.push(`<li class="diff-line-mod">renamed from <span class="diff-old">${escapeHtml(c.titleBefore)}</span></li>`);
        }
        if (c.includedBefore !== c.includedAfter) {
          parts.push(`<li class="diff-line-mod">${c.includedAfter ? 'ticked back on' : 'unticked'}</li>`);
        }
        for (const s of c.steps.added) parts.push(`<li class="diff-line-add">${escapeHtml(s)}</li>`);
        for (const s of c.steps.removed) parts.push(`<li class="diff-line-del">${escapeHtml(s)}</li>`);
        return `<li class="diff-line-mod">${escapeHtml(c.title)}
          <ul class="diff-sub">${parts.join('')}</ul></li>`;
      }).join('');
      blocks.push(`<div class="diff-group"><div class="diff-group-head">Changed (${d.changed.length})</div><ul>${rows}</ul></div>`);
    }

    diffPanel.innerHTML = blocks.join('');
    diffPanel.classList.remove('hidden');
  }

  versionSelect.addEventListener('change', async () => {
    if (!versionSelect.value) {
      diffPanel.classList.add('hidden');
      diffSummary.textContent = '';
      return;
    }
    diffSummary.textContent = 'comparing…';
    try {
      const d = await api(`/runs/${currentRun.id}/versions/${versionSelect.value}/diff`);
      renderDiff(d);
      diffSummary.textContent = d.isEmpty
        ? 'identical'
        : `+${d.added.length} −${d.removed.length} ~${d.changed.length}`;
    } catch (err) {
      diffSummary.textContent = err.message;
    }
  });

  // ---------- Run list ----------
  async function loadRunList(selectId) {
    const runs = await api('/runs');
    runSelect.innerHTML = '<option value="">— new —</option>' +
      runs.map((r) => `<option value="${r.id}">${escapeHtml(r.featureTitle)} (${new Date(r.updatedAt).toLocaleString()})</option>`).join('');
    if (selectId) runSelect.value = selectId;
  }

  runSelect.addEventListener('change', async () => {
    if (!runSelect.value) {
      resultsPanel.classList.add('hidden');
      inputText.value = '';
      currentRun = null;
      return;
    }
    currentRun = await api(`/runs/${runSelect.value}`);
    showRun();
  });

  // ---------- Activity log ----------
  function makeLogger(logEl, itemsEl) {
    return {
      reset() {
        itemsEl.innerHTML = '';
        logEl.classList.remove('hidden');
      },
      log(message, kind) {
        const li = document.createElement('li');
        li.textContent = message;
        if (kind) li.className = kind;
        itemsEl.appendChild(li);
        itemsEl.parentElement.scrollTop = itemsEl.parentElement.scrollHeight;
      },
    };
  }

  const generateLog = makeLogger(activityLog, activityItems);
  const bulkLog = makeLogger(bulkActivityLog, bulkActivityItems);

  // Reads a Server-Sent Events response body, dispatching each frame to handlers.
  // Used by both generation and the whole-feature update.
  async function consumeSse(res, { onProgress, onDone, onFailed }) {
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let settled = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop();

      for (const frame of frames) {
        const lines = frame.split('\n');
        const eventLine = lines.find((l) => l.startsWith('event: '));
        const dataLine = lines.find((l) => l.startsWith('data: '));
        if (!eventLine || !dataLine) continue;

        const event = eventLine.slice(7).trim();
        const payload = JSON.parse(dataLine.slice(6));

        if (event === 'progress') onProgress(payload);
        else if (event === 'done') { settled = true; await onDone(payload); }
        else if (event === 'failed') { settled = true; onFailed(payload); }
      }
    }

    if (!settled) throw new Error('The connection closed before finishing.');
  }

  // ---------- Generate (streamed over SSE) ----------
  // Shared by three entry points: straight from the input box, from the page
  // picker after a discovery crawl, and from a finished recording session.
  async function runGeneration({ pages = null, recordings = null } = {}) {
    const text = inputText.value.trim();
    if (!pages && !recordings && !text) {
      setStatus(generateStatus, 'Please paste a link or describe what to test first.', 'error');
      return;
    }
    if (!selectedTypeIds().length) {
      setStatus(generateStatus, 'Pick at least one kind of test to write — see Options.', 'error');
      return;
    }

    const statusNode = pages ? pagePickerStatus : recordings ? recordPanelStatus : generateStatus;
    generateBtn.disabled = true;
    discoverBtn.disabled = true;
    generateFromPagesBtn.disabled = true;
    recordBtn.disabled = true;
    setStatus(statusNode, 'Working…');
    generateLog.reset();

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: text,
          ...(pages ? { pages } : {}),
          ...(recordings ? { recordings } : {}),
          interactive: interactiveToggle.checked,
          refine: refineToggle.checked,
          useSession: sessionToggle.checked,
          types: selectedTypeIds(),
          instructions: extraInstructions.value.trim(),
          testUsername: testUsername.value.trim(),
          testPassword: testPassword.value,
        }),
      });

      await consumeSse(res, {
        onProgress: (p) => generateLog.log(p.message),
        onDone: async (run) => {
          generateLog.log(`Generated ${run.scenarios.length} test cases`, 'done');
          currentRun = run;
          setStatus(statusNode, 'Done.', 'ok');
          await loadRunList(currentRun.id);
          showRun();
        },
        onFailed: (p) => {
          generateLog.log(p.error, 'failed');
          setStatus(statusNode, p.error, 'error');
        },
      });
    } catch (err) {
      generateLog.log(err.message, 'failed');
      setStatus(statusNode, err.message, 'error');
    } finally {
      // Not a flat `= false` — a bare URL still needs Explore, not Generate,
      // even after an unrelated run (e.g. from the page picker) just finished.
      updateUrlGate();
      discoverBtn.disabled = false;
      generateFromPagesBtn.disabled = false;
      recordBtn.disabled = false;
      updatePageCount();
    }
  }

  // ---------- Gate: a bare URL must go through Explore, not straight to Generate ----------
  // Mirrors detectUrl() in server/lib/claudeCli.js — a URL alongside real prose
  // still generates directly, since that prose becomes context either way.
  function isLikelyUrl(text) {
    const trimmed = text.trim();
    const match = trimmed.match(URL_PATTERN);
    if (!match || !isPlausibleDomain(match[0])) return false;
    const remainder = trimmed.replace(match[0], '').trim();
    return !remainder;
  }

  function updateUrlGate() {
    const gated = isLikelyUrl(inputText.value);
    generateBtn.disabled = gated;
    urlGateHint.classList.toggle('hidden', !gated);
  }

  inputText.addEventListener('input', updateUrlGate);

  generateBtn.addEventListener('click', () => runGeneration());

  // ---------- Universal update (whole feature, ticked items only) ----------
  updateAllBtn.addEventListener('click', async () => {
    const review = bulkReviewInput.value.trim();
    if (!review) {
      setStatus(bulkReviewStatus, 'Write what you want changed across the test cases first.', 'error');
      return;
    }

    const ticked = currentRun.scenarios.filter((s) => s.included !== false).length;
    if (!ticked) {
      setStatus(bulkReviewStatus, 'No test cases are ticked, so there is nothing to update.', 'error');
      return;
    }

    // Persist any pending inline edits first, so the update works from what's on screen.
    updateAllBtn.disabled = true;
    setStatus(bulkReviewStatus, 'Working…');
    bulkLog.reset();

    try {
      await api(`/runs/${currentRun.id}`, { method: 'PUT', body: JSON.stringify(currentRun) });

      const res = await fetch(`/api/runs/${currentRun.id}/update-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review }),
      });

      await consumeSse(res, {
        onProgress: (p) => bulkLog.log(p.message),
        onDone: async (run) => {
          bulkLog.log('Done', 'done');
          currentRun = run;
          bulkReviewInput.value = '';
          setStatus(bulkReviewStatus, 'All ticked test cases updated.', 'ok');
          renderFeatureHeader();
          renderQuality();
          renderScenarios();
          renderCoverage();
        },
        onFailed: (p) => {
          bulkLog.log(p.error, 'failed');
          setStatus(bulkReviewStatus, p.error, 'error');
        },
      });
    } catch (err) {
      bulkLog.log(err.message, 'failed');
      setStatus(bulkReviewStatus, err.message, 'error');
    } finally {
      updateAllBtn.disabled = false;
    }
  });

  function showRun() {
    resultsPanel.classList.remove('hidden');
    renderFeatureHeader();
    renderQuality();
    renderRefineNotes();
    renderScenarios();
    renderCoverage();
    loadVersions();
  }

  // ---------- Feature header ----------
  function renderFeatureHeader() {
    featureTitleInput.value = currentRun.featureTitle;
    featureDescriptionInput.value = currentRun.featureDescription || '';
    sourceUrlNote.textContent = currentRun.sourceUrl ? `Source: ${currentRun.sourceUrl}` : '';
  }
  featureTitleInput.addEventListener('input', () => { if (currentRun) currentRun.featureTitle = featureTitleInput.value; });
  featureDescriptionInput.addEventListener('input', () => { if (currentRun) currentRun.featureDescription = featureDescriptionInput.value; });

  // ---------- Scenarios ----------
  const KEYWORDS = ['Given', 'When', 'Then', 'And', 'But'];

  // Scenario cards show just the path, with the full URL on hover.
  function shortPath(url) {
    try {
      const u = new URL(url);
      return u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  function keywordSelectHtml(current) {
    const options = KEYWORDS.map(
      (k) => `<option value="${k}" ${k === current ? 'selected' : ''}>${k}</option>`
    ).join('');
    return `<select class="step-keyword-select" title="Step keyword">${options}</select>`;
  }

  function dataTableHtml(step) {
    if (!Array.isArray(step.dataTable) || !step.dataTable.length) return '';
    const rows = step.dataTable.map((row, rowIndex) => {
      const cells = row.map((cell, colIndex) =>
        `<td><input type="text" class="cell-input" data-row="${rowIndex}" data-col="${colIndex}" value="${escapeHtml(cell)}" /></td>`
      ).join('');
      return `<tr>${cells}<td class="row-control"><button class="mini-remove remove-row" data-row="${rowIndex}" title="Remove this row">✕</button></td></tr>`;
    }).join('');
    return `
      <div class="data-table-wrap">
        <table class="data-table"><tbody>${rows}</tbody></table>
        <div class="table-actions">
          <button class="secondary add-row">+ Row</button>
          <button class="secondary add-col">+ Column</button>
          <button class="secondary remove-col">− Column</button>
          <button class="danger-outline remove-table">Remove table</button>
        </div>
      </div>
    `;
  }

  // ---------- Scenario Outline placeholders ----------
  // Remembers the last text selection made inside a step input, because clicking
  // the toolbar button blurs the input.
  let lastSelection = null;

  function placeholdersIn(text) {
    return [...String(text ?? '').matchAll(/<([^<>]+)>/g)].map((m) => m[1].trim());
  }

  function scenarioPlaceholders(scenario) {
    const names = new Set();
    for (const step of scenario.steps) {
      for (const n of placeholdersIn(step.text)) names.add(n);
      if (Array.isArray(step.dataTable)) {
        for (const row of step.dataTable) for (const cell of row) placeholdersIn(cell).forEach((n) => names.add(n));
      }
    }
    return [...names];
  }

  function exampleHeaders(scenario) {
    return Array.isArray(scenario.examples) && scenario.examples.length
      ? scenario.examples[0].map((h) => String(h ?? '').trim())
      : [];
  }

  // Turns the selected words in a step into a <placeholder> and gives it an
  // Examples column, converting the scenario to an outline if needed.
  function makeVariable(scenario, step) {
    if (!lastSelection || lastSelection.stepId !== step.id) return 'Select the word in a step first, then press <>.';

    const { start, end } = lastSelection;
    const text = step.text;
    const selected = text.slice(start, end).trim();
    if (!selected) return 'Select the word you want to turn into a variable.';
    if (selected.includes('<') || selected.includes('>')) return 'That selection is already a variable.';

    const name = selected;
    if (scenarioPlaceholders(scenario).includes(name)) {
      // Already a column — just wrap this occurrence too.
      step.text = text.slice(0, start) + `<${name}>` + text.slice(end);
      lastSelection = null;
      return null;
    }

    step.text = text.slice(0, start) + `<${name}>` + text.slice(end);

    // The selected word names the column only. Data rows start empty — the value
    // to test is for the user to fill in, not a copy of the label.
    if (!Array.isArray(scenario.examples) || !scenario.examples.length) {
      scenario.examples = [[name], ['']];
    } else {
      scenario.examples[0].push(name);
      for (let r = 1; r < scenario.examples.length; r++) scenario.examples[r].push('');
    }

    scenario.isOutline = true;
    lastSelection = null;
    return null;
  }

  // Renaming a column has to rewrite every <old> token, or the outline breaks.
  function renamePlaceholder(scenario, oldName, newName) {
    const from = String(oldName).trim();
    const to = String(newName).trim();
    if (!from || !to || from === to) return;

    const swap = (t) => String(t ?? '').split(`<${from}>`).join(`<${to}>`);
    for (const step of scenario.steps) {
      step.text = swap(step.text);
      if (Array.isArray(step.dataTable)) {
        step.dataTable = step.dataTable.map((row) => row.map(swap));
      }
    }
  }

  function examplesHtml(scenario) {
    // No "make this an outline" button: pressing <> on a selected word already
    // converts the scenario AND creates the matching Examples column. Starting an
    // empty outline instead just produces a scenario the checks reject.
    if (!scenario.isOutline) {
      return `<div class="examples-empty">
        <span class="hint">To run this scenario against several values, select a word in any step and press <code>&lt;&gt;</code>.</span>
      </div>`;
    }

    const used = scenarioPlaceholders(scenario);
    const headers = exampleHeaders(scenario);
    const rows = (scenario.examples || []).map((row, rowIndex) => {
      const cells = row.map((cell, colIndex) => {
        const isHeader = rowIndex === 0;
        const orphan = isHeader && cell.trim() && !used.includes(cell.trim());
        return `<td class="${orphan ? 'orphan-col' : ''}">
          <input type="text" class="ex-cell" data-row="${rowIndex}" data-col="${colIndex}"
            value="${escapeHtml(cell)}" ${isHeader ? 'data-header="1" title="Renaming this also renames the &lt;placeholder&gt; in every step"' : ''} />
        </td>`;
      }).join('');
      const control = rowIndex === 0
        ? '<td class="row-control"></td>'
        : `<td class="row-control"><button class="mini-remove ex-remove-row" data-row="${rowIndex}" title="Remove this row">✕</button></td>`;
      return `<tr>${cells}${control}</tr>`;
    }).join('');

    const missing = used.filter((n) => !headers.includes(n));
    const warning = missing.length
      ? `<div class="examples-warning">${missing.map((n) => `&lt;${escapeHtml(n)}&gt;`).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no column — Cucumber would fail. Add the column or remove the placeholder.</div>`
      : '';

    return `
      <div class="examples-block">
        <div class="examples-head">
          <span class="examples-title">Examples</span>
          <span class="hint">One test run per row. Column names must match the <code>&lt;placeholders&gt;</code> in the steps.</span>
        </div>
        ${warning}
        <div class="data-table-wrap">
          <table class="data-table examples-table"><tbody>${rows}</tbody></table>
          <div class="table-actions">
            <button class="secondary ex-add-row">+ Row</button>
            <button class="secondary ex-add-col">+ Column</button>
            <button class="danger-outline unmake-outline">Back to plain Scenario</button>
          </div>
        </div>
      </div>
    `;
  }

  function scenarioCardHtml(scenario) {
    const stepsHtml = scenario.steps.map((step) => {
      return `
      <div class="step-block" data-step-id="${step.id}">
        <div class="step-row">
          <input type="checkbox" class="step-included" ${step.included !== false ? 'checked' : ''} title="Ticked: included in the export, and a review may rewrite this step. Unticked: left out of the export and never changed by a review." />
          ${keywordSelectHtml(step.keyword)}
          <input type="text" class="step-text" value="${escapeHtml(step.text)}" placeholder="Describe this step" />
          <button class="step-var" title="Select a word in this step, then press this to turn it into a &lt;variable&gt; with an Examples column">&lt;&gt;</button>
          <button class="step-remove" title="Remove step">✕</button>
        </div>
        ${dataTableHtml(step)}
      </div>
    `;
    }).join('');

    const lastReview = scenario.lastReviewApplied
      ? `<div class="last-review-note">Last review applied: "${escapeHtml(scenario.lastReviewApplied)}"</div>`
      : '';

    return `
      <div class="scenario-card" data-scenario-id="${scenario.id}" data-type-id="${escapeHtml(scenario.testType || '')}">
        <div class="scenario-top">
          <input type="checkbox" class="scenario-included" ${scenario.included !== false ? 'checked' : ''} title="Ticked: included in the export, and 'Update all' will apply reviews to it. Unticked: left out of the export and skipped by 'Update all'." />
          <input type="text" class="scenario-title-input" value="${escapeHtml(scenario.title)}" placeholder="Name this scenario" />
          ${scenario.page ? `<span class="page-badge" title="${escapeHtml(scenario.page)}">${escapeHtml(shortPath(scenario.page))}</span>` : ''}
          <button class="danger-outline delete-scenario" title="Delete scenario">Delete</button>
        </div>
        <div class="scenario-steps">${stepsHtml}</div>
        ${examplesHtml(scenario)}
        <div class="add-step-row">
          <span class="add-step-label">Add step:</span>
          ${KEYWORDS.map((k) => `<button class="secondary add-step-btn" data-keyword="${k}">+ ${k}</button>`).join('')}
        </div>
        <div class="scenario-footer">
          ${scenario.isDraft ? `
            <p class="muted-text">Not written yet — give it a title above, then generate its steps.</p>
            <div class="draft-actions">
              <button class="primary generate-scenario-btn">Generate</button>
              <button class="link-btn record-scenario-btn">Record a flow instead</button>
            </div>
          ` : `
            <div class="review-row">
              <textarea class="review-input" placeholder="Review notes for this test case (e.g. 'add a step for empty input')">${escapeHtml(scenario.review || '')}</textarea>
              <button class="primary update-scenario-btn">Update</button>
            </div>
            ${lastReview}
          `}
          <span class="status scenario-status"></span>
        </div>
      </div>
    `;
  }

  function renderScenarios() {
    scenarioList.innerHTML = currentRun.scenarios.map(scenarioCardHtml).join('');
  }

  function findScenario(id) {
    return currentRun.scenarios.find((s) => s.id === id);
  }

  scenarioList.addEventListener('click', async (e) => {
    const card = e.target.closest('.scenario-card');
    if (!card) return;
    const scenario = findScenario(card.dataset.scenarioId);

    if (e.target.classList.contains('delete-scenario')) {
      if (!(await customConfirm('Delete this scenario?', { okLabel: 'Delete', danger: true }))) return;
      currentRun.scenarios = currentRun.scenarios.filter((s) => s.id !== scenario.id);
      renderScenarios();
      renderCoverage();
      return;
    }

    const stepBlock = e.target.closest('.step-block');
    const step = stepBlock ? scenario.steps.find((s) => s.id === stepBlock.dataset.stepId) : null;

    if (e.target.classList.contains('step-remove')) {
      scenario.steps = scenario.steps.filter((s) => s.id !== step.id);
      renderScenarios();
      return;
    }

    if (e.target.classList.contains('add-step-btn')) {
      scenario.steps.push({
        id: crypto.randomUUID(),
        keyword: e.target.dataset.keyword || 'And',
        text: '',
        included: true,
        dataTable: null,
      });
      renderScenarios();
      return;
    }

    // ---- Scenario Outline controls ----
    if (e.target.classList.contains('step-var')) {
      const problem = makeVariable(scenario, step);
      const statusNode = card.querySelector('.scenario-status');
      if (problem) setStatus(statusNode, problem, 'error');
      else renderScenarios();
      return;
    }

    if (e.target.classList.contains('unmake-outline')) {
      const used = scenarioPlaceholders(scenario);
      if (used.length && !(await customConfirm(
        `This scenario still uses ${used.map((n) => `<${n}>`).join(', ')}. Turning it back into a plain Scenario leaves those as literal text. Continue?`,
        { okLabel: 'Continue', danger: true }
      ))) {
        return;
      }
      scenario.isOutline = false;
      scenario.examples = null;
      renderScenarios();
      return;
    }

    if (e.target.classList.contains('ex-add-row')) {
      const width = scenario.examples[0].length;
      scenario.examples.push(Array(width).fill(''));
      renderScenarios();
      return;
    }

    if (e.target.classList.contains('ex-remove-row')) {
      const rowIndex = Number(e.target.dataset.row);
      if (scenario.examples.length > 2) {
        scenario.examples.splice(rowIndex, 1);
        renderScenarios();
      } else {
        setStatus(card.querySelector('.scenario-status'), 'An outline needs at least one Examples row.', 'error');
      }
      return;
    }

    if (e.target.classList.contains('ex-add-col')) {
      scenario.examples[0].push('variable');
      for (let r = 1; r < scenario.examples.length; r++) scenario.examples[r].push('');
      renderScenarios();
      return;
    }

    // ---- Data table controls ----
    // A data table is only ever created by generation (a step handed a list of
    // records). Editing and removal stay available; there's no per-step "add"
    // button, since <> covers the parameterising case.
    if (e.target.classList.contains('remove-table')) {
      step.dataTable = null;
      renderScenarios();
      return;
    }

    if (e.target.classList.contains('add-row')) {
      const width = step.dataTable[0].length;
      step.dataTable.push(Array(width).fill(''));
      renderScenarios();
      return;
    }

    if (e.target.classList.contains('remove-row')) {
      const rowIndex = Number(e.target.dataset.row);
      if (step.dataTable.length > 1) {
        step.dataTable.splice(rowIndex, 1);
        renderScenarios();
      }
      return;
    }

    if (e.target.classList.contains('add-col')) {
      step.dataTable.forEach((row, i) => row.push(i === 0 ? `column ${row.length + 1}` : ''));
      renderScenarios();
      return;
    }

    if (e.target.classList.contains('remove-col')) {
      if (step.dataTable[0].length > 1) {
        step.dataTable.forEach((row) => row.pop());
        renderScenarios();
      }
      return;
    }

    if (e.target.classList.contains('generate-scenario-btn')) {
      const statusNode = card.querySelector('.scenario-status');
      const title = card.querySelector('.scenario-title-input').value.trim();
      if (!title) { setStatus(statusNode, 'Give this scenario a title first.', 'error'); return; }
      e.target.disabled = true;
      setStatus(statusNode, currentRun.sourceUrl ? 'Exploring the page…' : 'Working…');
      try {
        // The scenario only exists in the browser so far — persist the whole
        // run first (same reason "Update all" does this) so the server has
        // something to look up by id.
        await api(`/runs/${currentRun.id}`, { method: 'PUT', body: JSON.stringify(currentRun) });
        const generated = await api(`/runs/${currentRun.id}/scenarios/${scenario.id}/generate`, {
          method: 'POST',
          body: JSON.stringify({ title }),
        });
        Object.assign(scenario, generated);
        renderScenarios();
        renderCoverage();
      } catch (err) {
        setStatus(statusNode, err.message, 'error');
        e.target.disabled = false;
      }
      return;
    }

    if (e.target.classList.contains('record-scenario-btn')) {
      const statusNode = card.querySelector('.scenario-status');
      const title = card.querySelector('.scenario-title-input').value.trim();
      if (!title) { setStatus(statusNode, 'Give this scenario a title first.', 'error'); return; }
      if (recordingSessionId) { setStatus(statusNode, 'A recording session is already open — finish or discard it above first.', 'error'); return; }
      const url = extractUrl(inputText.value) || currentRun.sourceUrl || null;
      if (!url) { setStatus(statusNode, 'This run has no site link to record against — paste one in the box above first.', 'error'); return; }
      e.target.disabled = true;
      scenario.title = title;
      try {
        // Persist the title now — the recording can take a while, and the
        // server fills this scenario in by its (already-saved) title once done.
        await api(`/runs/${currentRun.id}`, { method: 'PUT', body: JSON.stringify(currentRun) });
      } catch (err) {
        setStatus(statusNode, err.message, 'error');
        e.target.disabled = false;
        return;
      }
      startRecording(url, { fromScenarioId: scenario.id });
      return;
    }

    if (e.target.classList.contains('update-scenario-btn')) {
      const statusNode = card.querySelector('.scenario-status');
      const review = card.querySelector('.review-input').value.trim();
      if (!review) { setStatus(statusNode, 'Write a review note first.', 'error'); return; }
      e.target.disabled = true;
      setStatus(statusNode, 'Updating…');
      try {
        const updated = await api(`/runs/${currentRun.id}/scenarios/${scenario.id}/update`, {
          method: 'POST',
          body: JSON.stringify({ review }),
        });
        Object.assign(scenario, updated);
        renderScenarios();
      } catch (err) {
        setStatus(statusNode, err.message, 'error');
        e.target.disabled = false;
      }
    }
  });

  scenarioList.addEventListener('change', (e) => {
    const card = e.target.closest('.scenario-card');
    if (!card) return;
    const scenario = findScenario(card.dataset.scenarioId);

    if (e.target.classList.contains('scenario-included')) {
      scenario.included = e.target.checked;
      return;
    }

    const stepBlock = e.target.closest('.step-block');
    const step = stepBlock ? scenario.steps.find((s) => s.id === stepBlock.dataset.stepId) : null;
    if (!step) return;

    if (e.target.classList.contains('step-included')) {
      step.included = e.target.checked;
    }
    if (e.target.classList.contains('step-keyword-select')) {
      step.keyword = e.target.value;
    }
  });

  scenarioList.addEventListener('input', (e) => {
    const card = e.target.closest('.scenario-card');
    if (!card) return;
    const scenario = findScenario(card.dataset.scenarioId);

    if (e.target.classList.contains('scenario-title-input')) {
      scenario.title = e.target.value;
      return;
    }
    if (e.target.classList.contains('review-input')) {
      scenario.review = e.target.value;
      return;
    }

    const stepBlock = e.target.closest('.step-block');
    const step = stepBlock ? scenario.steps.find((s) => s.id === stepBlock.dataset.stepId) : null;
    if (!step) return;

    if (e.target.classList.contains('step-text')) {
      step.text = e.target.value;
    }
    if (e.target.classList.contains('cell-input')) {
      const row = Number(e.target.dataset.row);
      const col = Number(e.target.dataset.col);
      if (step.dataTable?.[row]) step.dataTable[row][col] = e.target.value;
    }
  });

  // Examples cells live at scenario level, so they get their own handlers.
  // Header edits are committed on blur/Enter rather than per keystroke, because
  // renaming a column rewrites every <placeholder> and re-renders.
  scenarioList.addEventListener('input', (e) => {
    if (!e.target.classList.contains('ex-cell') || e.target.dataset.header) return;
    const card = e.target.closest('.scenario-card');
    const scenario = findScenario(card.dataset.scenarioId);
    const row = Number(e.target.dataset.row);
    const col = Number(e.target.dataset.col);
    if (scenario.examples?.[row]) scenario.examples[row][col] = e.target.value;
  });

  function commitHeaderRename(input) {
    const card = input.closest('.scenario-card');
    if (!card) return;
    const scenario = findScenario(card.dataset.scenarioId);
    const col = Number(input.dataset.col);
    const oldName = String(scenario.examples?.[0]?.[col] ?? '');
    const newName = input.value.trim();

    if (!newName || newName === oldName.trim()) {
      input.value = oldName;
      return;
    }
    if (newName.includes('<') || newName.includes('>')) {
      setStatus(card.querySelector('.scenario-status'), 'A column name must not include < or >.', 'error');
      input.value = oldName;
      return;
    }

    renamePlaceholder(scenario, oldName, newName);
    scenario.examples[0][col] = newName;
    renderScenarios();
  }

  scenarioList.addEventListener('blur', (e) => {
    if (e.target.classList?.contains('ex-cell') && e.target.dataset.header) commitHeaderRename(e.target);
  }, true);

  scenarioList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList?.contains('ex-cell') && e.target.dataset.header) {
      e.preventDefault();
      e.target.blur();
    }
  });

  // Track the selection inside step inputs so the <> button knows what to wrap.
  function rememberSelection(e) {
    const input = e.target;
    if (!input.classList?.contains('step-text')) return;
    const block = input.closest('.step-block');
    if (!block) return;
    lastSelection = {
      stepId: block.dataset.stepId,
      start: input.selectionStart,
      end: input.selectionEnd,
    };
  }

  scenarioList.addEventListener('select', rememberSelection);
  scenarioList.addEventListener('mouseup', rememberSelection);
  scenarioList.addEventListener('keyup', rememberSelection);

  addScenarioBtn.addEventListener('click', () => {
    currentRun.scenarios.push({
      id: crypto.randomUUID(),
      title: '',
      included: true,
      review: '',
      coversRequirementIds: [],
      // Never actually generated yet — the card shows a "Generate" button
      // instead of the usual review-note+Update footer until this succeeds.
      isDraft: true,
      steps: [
        { id: crypto.randomUUID(), keyword: 'Given', text: '', included: true, dataTable: null },
        { id: crypto.randomUUID(), keyword: 'When', text: '', included: true, dataTable: null },
        { id: crypto.randomUUID(), keyword: 'Then', text: '', included: true, dataTable: null },
      ],
    });
    renderScenarios();
  });

  // ---------- Coverage ----------
  function renderCoverage() {
    const total = currentRun.requirements.length;
    const covered = currentRun.requirements.filter((r) => r.covered).length;
    coverageFill.style.width = total ? `${Math.round((covered / total) * 100)}%` : '0%';
    coverageLabel.textContent = `${covered} / ${total} requirements confirmed`;

    requirementList.innerHTML = currentRun.requirements.map((req) => {
      const scenarioTitles = currentRun.scenarios
        .filter((s) => (s.coversRequirementIds || []).includes(req.id))
        .map((s) => s.title);
      const coverageNote = scenarioTitles.length
        ? `Covered by: ${scenarioTitles.map(escapeHtml).join(', ')}`
        : 'No scenario currently references this requirement.';
      return `
        <div class="requirement-row" data-req-id="${req.id}">
          <input type="checkbox" class="requirement-covered" ${req.covered ? 'checked' : ''} />
          <div>
            <div class="requirement-text">${escapeHtml(req.text)}</div>
            <div class="requirement-scenarios">${coverageNote}</div>
          </div>
        </div>
      `;
    }).join('') || '<p class="hint">No requirements extracted for this run.</p>';
  }

  requirementList.addEventListener('change', (e) => {
    if (!e.target.classList.contains('requirement-covered')) return;
    const row = e.target.closest('.requirement-row');
    const req = currentRun.requirements.find((r) => r.id === row.dataset.reqId);
    req.covered = e.target.checked;
    renderCoverage();
  });

  // ---------- Save / Export ----------
  async function saveCurrentRun(statusNode, btn) {
    if (btn) btn.disabled = true;
    setStatus(statusNode, 'Saving…');
    try {
      currentRun = await api(`/runs/${currentRun.id}`, { method: 'PUT', body: JSON.stringify(currentRun) });
      renderQuality(); // ticks and edits change what the checks see
      setStatus(statusNode, 'Saved.', 'ok');
    } catch (err) {
      setStatus(statusNode, err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  saveRunBtn.addEventListener('click', () => saveCurrentRun(saveStatus, saveRunBtn));
  saveCoverageBtn.addEventListener('click', () => saveCurrentRun(coverageSaveStatus, saveCoverageBtn));

  exportBtn.addEventListener('click', () => {
    window.location.href = `/api/runs/${currentRun.id}/export`;
  });

  el('exportXlsxBtn').addEventListener('click', () => {
    window.location.href = `/api/runs/${currentRun.id}/export.xlsx`;
  });

  exportToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    exportOptions.classList.toggle('hidden');
  });

  // Any download closes the menu; so does clicking away from it.
  exportOptions.addEventListener('click', () => exportOptions.classList.add('hidden'));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.export-menu')) exportOptions.classList.add('hidden');
  });

  el('exportShareBtn').addEventListener('click', () => {
    window.location.href = `/api/runs/${currentRun.id}/export.json`;
  });

  el('exportTraceBtn').addEventListener('click', () => {
    window.location.href = `/api/runs/${currentRun.id}/traceability.xlsx`;
  });

  // ---------- Fill coverage gaps ----------
  const fillGapsBtn = el('fillGapsBtn');
  const gapLog = makeLogger(el('gapActivityLog'), el('gapActivityItems'));

  fillGapsBtn.addEventListener('click', async () => {
    const live = currentRun.scenarios.filter((s) => s.included !== false);
    const covered = new Set(live.flatMap((s) => s.coversRequirementIds || []));
    const gaps = currentRun.requirements.filter((r) => !covered.has(r.id));

    if (!gaps.length) {
      setStatus(coverageSaveStatus, 'Every requirement already has a test case.', 'ok');
      return;
    }

    fillGapsBtn.disabled = true;
    setStatus(coverageSaveStatus, `Writing tests for ${gaps.length} gap${gaps.length === 1 ? '' : 's'}…`);
    gapLog.reset();

    try {
      const res = await fetch(`/api/runs/${currentRun.id}/fill-gaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      await consumeSse(res, {
        onProgress: (p) => gapLog.log(p.message),
        onDone: async (run) => {
          gapLog.log('Done', 'done');
          currentRun = run;
          setStatus(coverageSaveStatus, 'Missing test cases added.', 'ok');
          renderQuality();
          renderScenarios();
          renderCoverage();
          loadVersions();
        },
        onFailed: (p) => {
          gapLog.log(p.error, 'failed');
          setStatus(coverageSaveStatus, p.error, 'error');
        },
      });
    } catch (err) {
      gapLog.log(err.message, 'failed');
      setStatus(coverageSaveStatus, err.message, 'error');
    } finally {
      fillGapsBtn.disabled = false;
    }
  });

  // ---------- Progressive disclosure: keep rarely-needed panels tucked away ----------
  sessionSetupToggle.addEventListener('click', () => {
    const hidden = sessionBorrow.classList.toggle('hidden');
    sessionSetupToggle.textContent = hidden ? 'Set one up →' : 'Hide';
  });

  function updateCredentialFieldsVisibility() {
    credentialFields.classList.toggle('hidden', !interactiveToggle.checked);
  }
  interactiveToggle.addEventListener('change', updateCredentialFieldsVisibility);
  updateCredentialFieldsVisibility();

  // ---------- Init ----------
  updateUrlGate();
  loadTestTypes().then(loadRunList).then(loadSessionState).catch((err) =>
    setStatus(generateStatus, `Could not start up: ${err.message}`, 'error')
  );
})();
