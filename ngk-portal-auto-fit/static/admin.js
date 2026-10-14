const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let csrf = '';
let events = [];
let participants = [];
let importRows = [];
/** Tracks whether the current template event has a custom uploaded template */
let hasCustomTemplate = false;
/** URL of the uploaded template image for preview */
let templateImageUrl = null;
/** Current field positions for custom template mode */
let fieldPositions = {};

const DYNAMIC_FIELDS = ['participant_name', 'event_name', 'event_date', 'certificate_id'];
const FIELD_LABELS = {
  participant_name: 'Participant Name',
  event_name: 'Event Name',
  event_date: 'Event Date',
  certificate_id: 'Certificate ID',
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast${error ? ' error' : ''}`;
  window.setTimeout(() => node.classList.add('hidden'), 3300);
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (csrf && options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = csrf;
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && url !== '/api/login') {
    showLogin();
    throw new Error('Your session expired. Please sign in again.');
  }
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : response;
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function showLogin() {
  $('#dashboard-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

function showDashboard() {
  $('#login-view').classList.add('hidden');
  $('#dashboard-view').classList.remove('hidden');
  $('#admin-email').textContent = $('#admin-email').dataset.value || '';
  loadAll();
}

async function boot() {
  try {
    const session = await api('/api/session');
    if (session.authenticated) {
      csrf = session.csrf;
      $('#admin-email').dataset.value = session.email;
      showDashboard();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $('#login-error').textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: form.get('email'), password: form.get('password') })
    });
    csrf = data.csrf;
    $('#admin-email').dataset.value = data.email;
    showDashboard();
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});

$('#logout-button').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
  } finally {
    csrf = '';
    showLogin();
  }
});

$$('.nav-item[data-page]').forEach((button) => {
  button.addEventListener('click', () => navigate(button.dataset.page));
});
$$('[data-goto]').forEach((button) => {
  button.addEventListener('click', () => navigate(button.dataset.goto));
});

function navigate(page) {
  $$('.nav-item[data-page]').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
  });
  $$('.page').forEach((section) => {
    section.classList.toggle('active', section.id === `page-${page}`);
  });
  if (page === 'participants') loadParticipants();
  if (page === 'events') renderEvents();
  if (page === 'templates') loadTemplate();
}

async function loadAll() {
  try {
    await Promise.all([loadEvents(), loadSummary(), loadParticipants()]);
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadEvents() {
  const data = await api('/api/admin/events');
  events = data.events;
  renderEvents();
  fillEventSelects();
}

async function loadSummary() {
  const { stats, recent_events, recent_participants } = await api('/api/admin/summary');
  const cards = [
    ['Events', stats.events, 'In your workspace', '▦'],
    ['Participants', stats.participants, 'Across all events', '♧'],
    ['Certificates available', stats.certificates, 'Ready to download', '✦'],
    ['Certificates downloaded', stats.downloads, 'Total downloads', '↓']
  ];
  $('#stat-cards').innerHTML = cards.map((card) => `
    <article class="stat-card">
      <div class="stat-top">${card[0]}<span class="stat-icon">${card[3]}</span></div>
      <div class="stat-value">${Number(card[1]).toLocaleString()}</div>
      <div class="stat-caption">${card[2]}</div>
    </article>`).join('');

  $('#recent-events').innerHTML = recent_events.length
    ? recent_events.map((event) => `
      <div class="recent-row">
        <span class="recent-icon">▦</span>
        <div class="recent-copy"><strong>${esc(event.name)}</strong>
          <small>${esc(event.event_date || 'Date not set')} · ${event.participant_count} participants</small>
        </div><span class="recent-tail">${esc(event.status)}</span>
      </div>`).join('')
    : '<div class="empty-state">No events yet. Create an event to get started.</div>';

  $('#recent-participants').innerHTML = recent_participants.length
    ? recent_participants.map((person) => `
      <div class="recent-row">
        <span class="admin-avatar">${esc((person.student_name || '?')[0].toUpperCase())}</span>
        <div class="recent-copy"><strong>${esc(person.student_name)}</strong>
          <small>${esc(person.event_name)}</small>
        </div><span class="recent-tail">Available</span>
      </div>`).join('')
    : '<div class="empty-state">No participants yet.</div>';
}

function renderEvents() {
  const query = ($('#event-search')?.value || '').toLowerCase();
  const filtered = events.filter((event) => event.name.toLowerCase().includes(query)
    || String(event.venue).toLowerCase().includes(query));
  $('#event-count').textContent = `${filtered.length} event${filtered.length === 1 ? '' : 's'}`;
  $('#events-table').innerHTML = filtered.length
    ? filtered.map((event) => `
      <tr>
        <td><span class="table-name">${esc(event.name)}</span>
          <span class="table-sub">Created ${esc((event.created_at || '').slice(0, 10))}</span></td>
        <td>${esc(event.event_date || '—')}</td><td>${esc(event.venue || '—')}</td>
        <td>${event.participant_count ?? 0}</td>
        <td><span class="badge ${event.status === 'Draft' ? 'draft' : ''}">${esc(event.status)}</span></td>
        <td><div class="row-actions">
          <button class="action-button" data-edit-event="${event.id}">Edit</button>
          <button class="action-button" data-import-event="${event.id}">Import</button>
          <button class="action-button" data-delete-event="${event.id}">Delete</button>
        </div></td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No events yet. Create an event to get started.</td></tr>';
  $$('[data-edit-event]').forEach((button) => {
    button.onclick = () => openEvent(Number(button.dataset.editEvent));
  });
  $$('[data-import-event]').forEach((button) => {
    button.onclick = () => openImport(Number(button.dataset.importEvent));
  });
  $$('[data-delete-event]').forEach((button) => {
    button.onclick = () => deleteEvent(Number(button.dataset.deleteEvent));
  });
}

$('#event-search').addEventListener('input', renderEvents);

function fillEventSelects() {
  const options = events.map((event) => `<option value="${event.id}">${esc(event.name)}</option>`).join('');
  for (const select of [$('#import-event'), $('#edit-event'), $('#template-event')]) {
    const previous = select.value;
    select.innerHTML = options;
    if (events.some((event) => String(event.id) === previous)) select.value = previous;
  }
  const filter = $('#participant-event-filter');
  const previousFilter = filter.value;
  filter.innerHTML = '<option value="">All events</option>' + options;
  if (events.some((event) => String(event.id) === previousFilter)) filter.value = previousFilter;
}

$('#new-event').onclick = $('#new-event-top').onclick = () => openEvent();

function openEvent(id) {
  const form = $('#event-form');
  form.reset();
  form.elements.id.value = '';
  $('#event-dialog-title').textContent = id ? 'Edit event' : 'Create event';
  if (id) {
    const event = events.find((item) => item.id === id);
    for (const key of ['name', 'event_date', 'venue', 'description', 'status']) {
      form.elements[key].value = event[key] || '';
    }
    form.elements.id.value = id;
  }
  $('#event-error').textContent = '';
  $('#event-dialog').showModal();
}

$('#event-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = form.get('id');
  const body = Object.fromEntries(['name', 'event_date', 'venue', 'description', 'status']
    .map((key) => [key, form.get(key)]));
  try {
    await api(id ? `/api/admin/events/${id}` : '/api/admin/events', {
      method: id ? 'PUT' : 'POST', body: JSON.stringify(body)
    });
    $('#event-dialog').close();
    await loadEvents();
    await loadSummary();
    toast(id ? 'Event updated.' : 'Event created.');
  } catch (error) {
    $('#event-error').textContent = error.message;
  }
});

async function deleteEvent(id) {
  const event = events.find((item) => item.id === id);
  if (!window.confirm(`Delete "${event.name}" and its participants? This cannot be undone.`)) return;
  try {
    await api(`/api/admin/events/${id}`, { method: 'DELETE' });
    await loadEvents();
    await loadParticipants();
    await loadSummary();
    toast('Event deleted.');
  } catch (error) {
    toast(error.message, true);
  }
}

$('#import-from-people').onclick = () => openImport();

function openImport(id) {
  fillEventSelects();
  if (id) $('#import-event').value = id;
  $('#import-error').textContent = '';
  $('#import-preview-wrap').classList.add('hidden');
  $('#confirm-import').classList.add('hidden');
  $('#import-file').value = '';
  $('#parse-import').classList.remove('hidden');
  $('#import-dialog').showModal();
}

$('#parse-import').onclick = async () => {
  const file = $('#import-file').files[0];
  if (!file) {
    $('#import-error').textContent = 'Choose a participant file first.';
    return;
  }
  const body = new FormData();
  body.append('file', file);
  $('#import-error').textContent = 'Reading file…';
  try {
    const data = await api('/api/admin/import/preview', { method: 'POST', body });
    importRows = data.rows;
    renderImportPreview();
    $('#preview-count').textContent = `${data.count} record${data.count === 1 ? '' : 's'} detected · ${esc(data.filename)}`;
    $('#import-preview-wrap').classList.remove('hidden');
    $('#confirm-import').classList.remove('hidden');
    $('#parse-import').classList.add('hidden');
    $('#import-error').textContent = '';
  } catch (error) {
    $('#import-error').textContent = error.message;
  }
};

function renderImportPreview() {
  $('#import-preview').innerHTML = importRows.map((row, index) => `
    <tr data-index="${index}">
      <td><input data-key="student_name" value="${esc(row.student_name)}"></td>
      <td><input data-key="mobile" value="${esc(row.mobile)}"></td>
      <td><input data-key="email" value="${esc(row.email)}"></td>
      <td><input data-key="participation" value="${esc(row.participation)}"></td>
      <td><button class="remove-row" type="button" data-remove-row="${index}" aria-label="Remove row">×</button></td>
    </tr>`).join('');
  $$('#import-preview tr').forEach((row) => {
    row.querySelectorAll('input').forEach((input) => {
      input.oninput = () => { importRows[Number(row.dataset.index)][input.dataset.key] = input.value; };
    });
  });
  $$('[data-remove-row]').forEach((button) => {
    button.onclick = () => {
      importRows.splice(Number(button.dataset.removeRow), 1);
      renderImportPreview();
      $('#preview-count').textContent = `${importRows.length} record${importRows.length === 1 ? '' : 's'} ready to import`;
    };
  });
}

$('#confirm-import').onclick = async () => {
  const button = $('#confirm-import');
  button.disabled = true;
  button.textContent = 'Importing…';
  try {
    const data = await api('/api/admin/import/commit', {
      method: 'POST',
      body: JSON.stringify({ event_id: Number($('#import-event').value), rows: importRows })
    });
    $('#import-dialog').close();
    await loadEvents();
    await loadParticipants();
    await loadSummary();
    toast(`Imported ${data.imported}; skipped ${data.skipped} duplicate${data.skipped === 1 ? '' : 's'}.`);
    if (data.errors.length) window.alert(`Some rows were skipped:\n${data.errors.slice(0, 10).join('\n')}`);
  } catch (error) {
    $('#import-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Import participants';
  }
};

async function loadParticipants() {
  try {
    const params = new URLSearchParams();
    if ($('#participant-search')?.value) params.set('q', $('#participant-search').value);
    if ($('#participant-event-filter')?.value) params.set('event_id', $('#participant-event-filter').value);
    const data = await api(`/api/admin/participants?${params}`);
    participants = data.participants;
    $('#participants-table').innerHTML = participants.length
      ? participants.map((person) => `
        <tr>
          <td><span class="table-name">${esc(person.student_name)}</span>
            <span class="table-sub">ID ${esc(person.certificate_id)}</span></td>
          <td>${esc(person.mobile)}</td><td>${esc(person.email)}</td><td>${esc(person.event_name)}</td>
          <td><span class="badge">Available</span></td>
          <td><div class="row-actions">
            <button class="action-button" data-edit-person="${person.id}">Edit</button>
            <button class="action-button" data-delete-person="${person.id}">Delete</button>
          </div></td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty-state">No participants yet.</td></tr>';
    $$('[data-edit-person]').forEach((button) => {
      button.onclick = () => openParticipant(Number(button.dataset.editPerson));
    });
    $$('[data-delete-person]').forEach((button) => {
      button.onclick = () => deleteParticipant(Number(button.dataset.deletePerson));
    });
  } catch (error) {
    if (!error.message.toLowerCase().includes('session')) toast(error.message, true);
  }
}

$('#participant-search').addEventListener('input', debounce(loadParticipants, 220));
$('#participant-event-filter').addEventListener('change', loadParticipants);

function debounce(callback, delay) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
}

function openParticipant(id) {
  const person = participants.find((item) => item.id === id);
  const form = $('#participant-form');
  fillEventSelects();
  for (const key of ['id', 'student_name', 'mobile', 'email', 'event_id', 'participation']) {
    form.elements[key].value = person[key] ?? '';
  }
  $('#participant-error').textContent = '';
  $('#participant-dialog').showModal();
}

$('#participant-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = form.get('id');
  const body = {};
  for (const key of ['student_name', 'mobile', 'email', 'event_id', 'participation']) body[key] = form.get(key);
  try {
    await api(`/api/admin/participants/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    $('#participant-dialog').close();
    await loadParticipants();
    await loadSummary();
    toast('Participant updated.');
  } catch (error) {
    $('#participant-error').textContent = error.message;
  }
});

async function deleteParticipant(id) {
  const person = participants.find((item) => item.id === id);
  if (!window.confirm(`Delete participant ${person.student_name}?`)) return;
  try {
    await api(`/api/admin/participants/${id}`, { method: 'DELETE' });
    await loadParticipants();
    await loadEvents();
    await loadSummary();
    toast('Participant deleted.');
  } catch (error) {
    toast(error.message, true);
  }
}

$('#export-csv').onclick = () => { window.location.href = '/api/admin/export?format=csv'; };
$('#export-xlsx').onclick = () => { window.location.href = '/api/admin/export?format=xlsx'; };
$('#template-event').addEventListener('change', loadTemplate);


/* ===========================================================
   TEMPLATE MANAGEMENT — supports both default & custom modes
   =========================================================== */

async function loadTemplate() {
  const id = $('#template-event').value;
  if (!id) {
    $('#template-fields').classList.add('hidden');
    return;
  }
  try {
    const data = await api(`/api/admin/templates/${id}`);
    const config = data.configuration;
    $('#template-fields').classList.remove('hidden');

    // Populate default text config fields
    $('#cfg-title').value = config.title || '';
    $('#cfg-intro').value = config.intro || '';
    $('#cfg-participation').value = config.participation_text || '';
    $('#cfg-organization').value = config.organization || '';
    $('#cfg-organizer').value = config.organizer || '';
    $('#cfg-footer').value = config.footer || '';
    $('#cfg-name-size').value = config.name_size || 30;
    $('#cfg-event-size').value = config.event_size || 18;
    $('#cfg-accent').value = config.accent || '#4054c5';

    // Determine template mode
    hasCustomTemplate = data.uploaded;
    templateImageUrl = data.template_image_url || null;
    fieldPositions = data.field_positions || {};

    if (data.filename) {
      $('#template-file-note').textContent = `Current template: ${data.filename}. Upload another file to replace it.`;
    } else {
      $('#template-file-note').innerHTML =
        'Upload your pre-designed certificate. PNG, JPG or PDF up to 12 MB.<br>' +
        'All existing text, logos, signatures and decorations will be preserved.';
    }

    // Switch between custom and default mode
    switchTemplateMode(hasCustomTemplate && templateImageUrl);

    // Populate field position controls
    if (hasCustomTemplate) {
      populateFieldPositionControls(fieldPositions);
    }

    updateTemplatePreview();
  } catch (error) {
    toast(error.message, true);
  }
}

/** Switch the admin UI between custom-template mode and default-design mode. */
function switchTemplateMode(isCustom) {
  const customControls = $('#custom-template-controls');
  const defaultControls = $('#default-template-controls');
  const customPreview = $('#custom-preview-wrap');
  const defaultPreview = $('#default-preview-wrap');
  const removeBtn = $('#remove-template');

  if (isCustom) {
    customControls.classList.remove('hidden');
    defaultControls.classList.add('hidden');
    customPreview.classList.remove('hidden');
    defaultPreview.classList.add('hidden');
    removeBtn.classList.remove('hidden');

    // Load the template image into the preview
    const img = $('#custom-preview-img');
    img.src = templateImageUrl + '?t=' + Date.now(); // cache-bust
    img.onload = () => renderCustomPreviewOverlays();
  } else {
    customControls.classList.add('hidden');
    defaultControls.classList.remove('hidden');
    customPreview.classList.add('hidden');
    defaultPreview.classList.remove('hidden');
    removeBtn.classList.add('hidden');
  }
}

/** Fill in the field position control inputs from server data. */
function populateFieldPositionControls(positions) {
  const autoFit = Object.values(positions).some((cfg) => cfg && cfg.auto_fit !== false);
  if ($('#fp-auto-fit')) $('#fp-auto-fit').checked = autoFit;
  for (const field of DYNAMIC_FIELDS) {
    const cfg = positions[field];
    if (!cfg) continue;
    const el = (prop) => $(`#fp-${field}-${prop}`);
    if (el('enabled')) el('enabled').checked = cfg.enabled !== false;
    if (el('x')) el('x').value = Math.round((cfg.x || 0) * 100);
    if (el('y')) el('y').value = Math.round((cfg.y || 0) * 100);
    if (el('size')) el('size').value = cfg.size || 14;
    if (el('color')) el('color').value = cfg.color || '#1a237e';
    if (el('align')) el('align').value = cfg.align || 'center';
  }
}

/** Read field positions from the form controls. */
function readFieldPositions() {
  const positions = {};
  const autoFit = $('#fp-auto-fit') ? $('#fp-auto-fit').checked : true;
  for (const field of DYNAMIC_FIELDS) {
    const el = (prop) => $(`#fp-${field}-${prop}`);
    positions[field] = {
      enabled: el('enabled') ? el('enabled').checked : true,
      x: (parseFloat(el('x')?.value || 50)) / 100,
      y: (parseFloat(el('y')?.value || 50)) / 100,
      size: parseInt(el('size')?.value || 14, 10),
      color: el('color')?.value || '#1a237e',
      align: el('align')?.value || 'center',
      auto_fit: autoFit,
      max_width: field === 'certificate_id' ? 0.42 : (field === 'event_date' ? 0.72 : 0.78),
    };
  }
  return positions;
}

/** Render colored overlay labels on the custom template preview image. */
function renderCustomPreviewOverlays() {
  const container = $('#custom-preview-container');
  if (!container) return;

  // Remove existing overlays
  container.querySelectorAll('.preview-field-overlay').forEach((el) => el.remove());

  const positions = readFieldPositions();
  const event = events.find((e) => e.id === Number($('#template-event').value));

  const sampleTexts = {
    participant_name: 'Participant Name',
    event_name: event?.name || 'Event Name',
    event_date: event?.event_date ? `held on ${event.event_date}` : 'held on the event date',
    certificate_id: 'Certificate ID: ECP-2026-ABCD1234',
  };

  const fieldColors = {
    participant_name: '#e91e63',
    event_name: '#2196f3',
    event_date: '#4caf50',
    certificate_id: '#ff9800',
  };

  for (const field of DYNAMIC_FIELDS) {
    const cfg = positions[field];
    if (!cfg || !cfg.enabled) continue;

    const overlay = document.createElement('div');
    overlay.className = 'preview-field-overlay';
    overlay.textContent = sampleTexts[field] || field;

    // Position using CSS: x is from left, y is from bottom
    overlay.style.left = `${(cfg.x * 100).toFixed(1)}%`;
    overlay.style.bottom = `${(cfg.y * 100).toFixed(1)}%`;
    overlay.style.fontSize = `${Math.max(8, Math.min(cfg.size, 28))}px`;
    overlay.style.color = cfg.color;
    overlay.style.fontWeight = cfg.size > 16 ? '700' : '400';

    // Alignment
    if (cfg.align === 'center') {
      overlay.style.transform = 'translateX(-50%)';
    } else if (cfg.align === 'right') {
      overlay.style.transform = 'translateX(-100%)';
    }

    // Add a subtle background label for visibility
    overlay.style.background = fieldColors[field] + '22';
    overlay.style.border = `1px dashed ${fieldColors[field]}`;
    overlay.style.borderRadius = '3px';
    overlay.style.padding = '1px 4px';

    container.appendChild(overlay);
  }
}

function updateTemplatePreview() {
  // Default preview elements
  const titleEl = $('#preview-title');
  const introEl = $('#preview-intro');
  const partEl = $('#preview-participation');
  const orgEl = $('#preview-organizer');
  const orgNameEl = $('#preview-organization');
  const eventEl = $('#preview-event');

  if (titleEl) titleEl.textContent = $('#cfg-title').value || 'CERTIFICATE OF PARTICIPATION';
  if (introEl) introEl.textContent = $('#cfg-intro').value || 'This certificate is proudly presented to';
  if (partEl) partEl.textContent = $('#cfg-participation').value || 'For successfully participating in';
  if (orgEl) orgEl.textContent = $('#cfg-organizer').value || 'Nehru Grand Kacheri';
  if (orgNameEl) orgNameEl.textContent = $('#cfg-organization').value || 'Nehru Grand Kacheri';
  if (eventEl) eventEl.textContent = events.find((event) => event.id === Number($('#template-event').value))?.name || 'Select an event';

  const mockTitle = document.querySelector('.mock-title');
  const mockName = document.querySelector('.mock-name');
  if (mockTitle) mockTitle.style.color = $('#cfg-accent').value;
  if (mockName) mockName.style.color = $('#cfg-accent').value;

  // Custom preview overlays
  if (hasCustomTemplate && templateImageUrl) {
    renderCustomPreviewOverlays();
  }
}

// Bind default design config inputs to live preview
$$(['#cfg-title', '#cfg-intro', '#cfg-participation', '#cfg-organizer', '#cfg-organization', '#cfg-event-size', '#cfg-name-size', '#cfg-accent'])
  .forEach((element) => element.addEventListener('input', updateTemplatePreview));

// Bind field position controls to live preview
for (const field of DYNAMIC_FIELDS) {
  for (const prop of ['enabled', 'x', 'y', 'size', 'color', 'align']) {
    const el = $(`#fp-${field}-${prop}`);
    if (el) {
      el.addEventListener('input', updateTemplatePreview);
      el.addEventListener('change', updateTemplatePreview);
    }
  }
}


/* ===========================================================
   SAVE TEMPLATE — handles both modes
   =========================================================== */

$('#save-template').onclick = async () => {
  const id = $('#template-event').value;
  if (!id) return;
  const body = new FormData();

  // Always send default text fields (they're used as fallback labels)
  const fields = {
    title: '#cfg-title', intro: '#cfg-intro', participation_text: '#cfg-participation',
    organization: '#cfg-organization', organizer: '#cfg-organizer', footer: '#cfg-footer',
    name_size: '#cfg-name-size', event_size: '#cfg-event-size', accent: '#cfg-accent'
  };
  for (const [key, selector] of Object.entries(fields)) body.append(key, $(selector).value);

  // Attach the file if selected
  if ($('#template-file').files[0]) body.append('file', $('#template-file').files[0]);

  // Send field positions for custom template mode
  const currentPositions = readFieldPositions();
  body.append('field_positions', JSON.stringify(currentPositions));

  try {
    const data = await api(`/api/admin/templates/${id}`, { method: 'POST', body });
    $('#template-file').value = '';

    // Update state from response
    if (data.template_image_url) {
      hasCustomTemplate = true;
      templateImageUrl = data.template_image_url;
    }
    if (data.field_positions) {
      fieldPositions = data.field_positions;
    }

    await loadTemplate();
    toast('Certificate template saved.');
  } catch (error) {
    toast(error.message, true);
  }
};


/* ===========================================================
   REMOVE CUSTOM TEMPLATE — revert to default design
   =========================================================== */

$('#remove-template').onclick = async () => {
  const id = $('#template-event').value;
  if (!id) return;
  if (!window.confirm('Remove the custom template and revert to the default certificate design?')) return;

  try {
    await api(`/api/admin/templates/${id}`, { method: 'DELETE' });
    hasCustomTemplate = false;
    templateImageUrl = null;
    fieldPositions = {};
    await loadTemplate();
    toast('Custom template removed. Reverted to default certificate design.');
  } catch (error) {
    toast(error.message, true);
  }
};


/* ===========================================================
   MODAL HANDLING
   =========================================================== */

$$('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog')?.close());
});
$$('dialog.modal').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
});

boot();
