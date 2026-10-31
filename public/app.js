'use strict';

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const thisMonth = () => today().slice(0, 7);
const dur = (m) => {
  const r = Math.round(m || 0);
  return r ? `${pad(Math.floor(r / 60))}:${pad(r % 60)}` : '';
};
const STATUS = { P: 'Present', A: 'Absent', HD: 'Half Day', MP: 'Missed Punch', WO: 'Weekly Off', HO: 'Holiday', L: 'Leave' };
const PUNCH = { 0: 'In', 1: 'Out', 2: 'Break Out', 3: 'Break In', 4: 'OT In', 5: 'OT Out' };
const VERIFY = { 0: 'Password', 1: 'Finger', 2: 'Card', 3: 'Password', 4: 'Card', 15: 'Face', 25: 'Palm' };
const badge = (s) => (s ? `<span class="badge s-${esc(s)}" title="${esc(STATUS[s] || s)}">${esc(s)}</span>` : '');

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && url !== '/login') {
    showLogin();
    throw new Error('Session expired, please sign in');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const get = (u) => api('GET', u);
const post = (u, b) => api('POST', u, b || {});
const put = (u, b) => api('PUT', u, b);
const del = (u) => api('DELETE', u);

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), err ? 6000 : 3500);
}

/** Runs an async action with a busy button and toast feedback. */
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    const msg = typeof okMsg === 'function' ? okMsg(r) : okMsg || r?.message;
    if (msg) toast(msg);
    return r;
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function table(headers, rows, cls = '') {
  return `<div class="table-wrap"><table class="${cls}"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="muted">No records</td></tr>`}</tbody></table></div>`;
}

/**
 * Opens a form modal. fields: [{name,label,type,options,value,required,full,help}]
 * Resolves with the form values, or null when cancelled.
 */
function formModal(title, fields, onSubmit, okLabel = 'Save', { cancel = true } = {}) {
  const dlg = $('#modal');
  $('#modalCancel').classList.toggle('hidden', !cancel);
  $('#modalTitle').textContent = title;
  $('#modalOk').textContent = okLabel;
  $('#modalError').textContent = '';
  $('#modalBody').innerHTML = fields.map((f) => {
    const v = f.value ?? '';
    let input;
    if (f.type === 'select') {
      input = `<select name="${f.name}">${f.options.map(([val, lab]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
    } else if (f.type === 'checks') {
      const chosen = (f.value || []).map(String);
      return `<fieldset class="full checks"><legend>${esc(f.label)}</legend>${f.options.map(([val, lab]) =>
        `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(val)}" ${chosen.includes(String(val)) ? 'checked' : ''}> ${esc(lab)}</label>`).join('')}${f.help ? `<span class="help">${f.help}</span>` : ''}</fieldset>`;
    } else if (f.type === 'checkbox') {
      input = `<input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}>`;
    } else if (f.type === 'textarea') {
      input = `<textarea name="${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
    } else if (f.type === 'html') {
      return `<div class="full help">${f.html}</div>`;
    } else {
      input = `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`;
    }
    return `<label class="${f.full ? 'full' : ''}">${esc(f.label)}${input}${f.help ? `<span class="help">${f.help}</span>` : ''}</label>`;
  }).join('');

  return new Promise((resolve) => {
    const form = $('#modalForm');
    const submit = async (ev) => {
      ev.preventDefault();
      if (ev.submitter?.value === 'cancel') { cleanup(); dlg.close(); return resolve(null); }
      if (!form.reportValidity()) return;
      const values = {};
      for (const f of fields) {
        if (!f.name) continue;
        if (f.type === 'checks') {
          values[f.name] = [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((x) => x.value);
          continue;
        }
        const el = form.elements[f.name];
        values[f.name] = f.type === 'checkbox' ? (el.checked ? 1 : 0) : f.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value.trim();
      }
      $('#modalOk').disabled = true;
      try {
        const r = onSubmit ? await onSubmit(values) : values;
        cleanup();
        dlg.close();
        resolve(r ?? values);
      } catch (e) {
        $('#modalError').textContent = e.message;
      } finally {
        $('#modalOk').disabled = false;
      }
    };
    const onClose = () => { cleanup(); resolve(null); };
    function cleanup() { form.removeEventListener('submit', submit); dlg.removeEventListener('cancel', onClose); }
    form.addEventListener('submit', submit);
    dlg.addEventListener('cancel', onClose);
    dlg.showModal();
  });
}

function showDetails(title, html) {
  return formModal(title, [{ type: 'html', html }], null, 'Close', { cancel: false });
}

// -------------------------------------------------------------------- auth
function showLogin() {
  $('#shell').classList.add('hidden');
  $('#login').classList.remove('hidden');
}
async function boot() {
  try {
    await get('/me');
    $('#login').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    route();
  } catch {
    showLogin();
  }
}
$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    await api('POST', '/login', { username: f.username.value, password: f.password.value });
    $('#loginError').textContent = '';
    f.password.value = '';
    boot();
  } catch (e) {
    $('#loginError').textContent = e.message;
  }
});
$('#logout').addEventListener('click', async () => { await post('/logout').catch(() => {}); showLogin(); });

// ------------------------------------------------------------------ router
const views = {};
async function route() {
  const name = (location.hash.slice(1) || 'dashboard').split('?')[0];
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${name}`));
  const view = $('#view');
  view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await (views[name] || views.dashboard)(view);
  } catch (e) {
    view.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
window.addEventListener('hashchange', route);

let shiftsCache = null;
async function shiftOptions() {
  shiftsCache = shiftsCache || (await get('/shifts'));
  return [['', '(Default shift)'], ...shiftsCache.map((s) => [s.id, `${s.name} (${s.start_time}-${s.end_time})`])];
}
async function departmentSelect(id = 'dept', selected = '') {
  const depts = await get('/departments');
  return `<label>Department<select id="${id}"><option value="">All</option>${depts.map((d) => `<option ${d === selected ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></label>`;
}

// --------------------------------------------------------------- dashboard
views.dashboard = async (el) => {
  const d = await get('/dashboard');
  const c = d.counts;
  const online = (dev) => {
    if (!dev.enabled) return '<span class="warn">Disabled</span>';
    if (dev.last_error) return `<span class="bad" title="${esc(dev.last_error)}">Error</span>`;
    return dev.last_seen ? `<span class="ok">OK</span> <span class="muted">${esc(dev.last_seen)}</span>` : '<span class="muted">Never connected</span>';
  };
  el.innerHTML = `
    <h1>Dashboard <span class="muted" style="font-size:14px">${esc(d.date)}</span></h1>
    <div class="grid">
      ${[['Employees', c.total], ['Present', c.present], ['Absent', c.absent], ['Late', c.late], ['On Leave', c.onLeave], ['Off / Holiday', c.off]]
        .map(([l, n]) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}
    </div>
    <div class="section"><h2>Devices</h2>
      ${table(['Name', 'Mode', 'Status', 'Last Sync'], d.devices.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.mode === 'push' ? 'ADMS (push)' : 'TCP/IP (pull)'}</td><td>${online(x)}</td><td>${esc(x.last_sync || '')}</td></tr>`))}
    </div>
    <div class="section"><h2>Recent punches</h2>
      ${table(['Time', 'Code', 'Name', 'Device', 'Type'], d.recent.map((p) => `<tr><td>${esc(p.punch_time)}</td><td>${esc(p.employee_code)}</td><td>${esc(p.employee_name)}</td><td>${esc(p.device_name || p.source)}</td><td>${esc(PUNCH[p.punch_state] ?? '')} ${esc(VERIFY[p.verify_type] ?? '')}</td></tr>`))}
    </div>`;
};

// ----------------------------------------------------------------- devices
/** "Clock 4 min behind" under the last sync time, from the last clock check. */
function clockText(d) {
  if (d.clock_drift == null) return '';
  const s = Math.abs(d.clock_drift);
  const est = d.clock_source === 'punch' ? ' (estimated from the latest punch)' : '';
  const when = `checked ${d.clock_checked_at || ''}${est}`;
  if (s <= 60) return `<br><span class="muted" title="${esc(when)}">Clock OK${s > 5 ? ` (${s} s ${d.clock_drift < 0 ? 'behind' : 'ahead'})` : ''}</span>`;
  const amount = s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `<br><span class="warn" title="${esc(when)}">Clock ${amount} ${d.clock_drift < 0 ? 'behind' : 'ahead'}${est ? ' (est.)' : ''}</span>`;
}

const deviceFields = (d = {}) => [
  { name: 'name', label: 'Name', value: d.name, required: true },
  { name: 'model', label: 'Model', value: d.model, placeholder: 'e.g. X990 / K30 / Orcus' },
  { name: 'mode', label: 'Connection mode', type: 'select', value: d.mode || 'pull', options: [['pull', 'TCP/IP – server connects to device (port 4370)'], ['push', 'ADMS / Cloud – device connects to server']] },
  { name: 'location', label: 'Location', value: d.location },
  { name: 'ip', label: 'IP address (TCP/IP mode)', value: d.ip, placeholder: '192.168.1.201' },
  { name: 'port', label: 'Port', type: 'number', value: d.port ?? 4370 },
  { name: 'transport', label: 'Protocol', type: 'select', value: d.transport || 'tcp', options: [['tcp', 'TCP'], ['udp', 'UDP (older firmware)']] },
  { name: 'comm_key', label: 'Comm key (device password)', type: 'number', value: d.comm_key ?? 0 },
  { name: 'serial_number', label: 'Serial number (required for ADMS)', value: d.serial_number },
  { name: 'poll_minutes', label: 'Auto-sync every (minutes)', type: 'number', value: d.poll_minutes, placeholder: 'default' },
  { name: 'auto_restart_at', label: 'ADMS: restart daily at (keeps clock right)', type: 'time', value: d.auto_restart_at, full: true,
    help: 'ADMS machines take the server time only when they connect. If the clock drifts, pick a quiet time (e.g. 03:30). Leave empty for no restart.' },
  { name: 'clear_after_sync', label: 'Clear device logs after each sync', type: 'checkbox', value: d.clear_after_sync },
  { name: 'enabled', label: 'Enabled', type: 'checkbox', value: d.enabled ?? 1 },
  { type: 'html', html: `<b>TCP/IP</b>: on the device open <i>Comm. → Ethernet</i> for the IP and <i>Comm. → Comm Key</i>. <b>ADMS</b>: set <i>Comm. → Cloud Server Setting</i> to <code>${esc(location.hostname)}</code> port <code>${esc(location.port || 80)}</code>; the device appears here automatically and must be enabled.` },
];

views.devices = async (el) => {
  const list = await get('/devices');
  el.innerHTML = `
    <div class="toolbar"><h1>Devices</h1><span class="spacer"></span>
      <button class="btn" id="testBtn">Test connection</button>
      <button class="btn primary" id="addBtn">Add device</button></div>
    ${table(['Name', 'Mode', 'Address / SN', 'Firmware', 'Users', 'Punches', 'Last sync', 'Status'], list.map((d) => `<tr class="info-row">
      <td><b>${esc(d.name)}</b><br><span class="muted">${esc(d.model || '')} ${esc(d.location || '')}</span></td>
      <td>${d.mode === 'push' ? 'ADMS' : `TCP/IP ${esc(d.transport?.toUpperCase())}`}</td>
      <td>${d.mode === 'pull' ? `${esc(d.ip)}:${esc(d.port)}` : ''}<br><span class="muted">${esc(d.serial_number || '')}</span></td>
      <td>${esc(d.firmware || '')}${algText(d) ? `<br><span class="muted" title="Matching algorithm versions">${esc(algText(d))}</span>` : ''}</td><td>${d.user_count ?? ''}</td><td>${d.punch_count}</td>
      <td>${esc(d.last_sync || '')}${clockText(d)}</td>
      <td>${!d.enabled ? '<span class="warn">Disabled</span>' : d.last_error ? `<span class="bad">${esc(d.last_error)}</span>` : '<span class="ok">OK</span>'}${d.pending_commands ? `<br><span class="muted">${d.pending_commands} queued cmd</span>` : ''}</td>
      </tr><tr class="action-row"><td colspan="8"><div class="actions btns" data-id="${d.id}" data-mode="${d.mode}">
        <button class="btn sm" data-a="sync">${d.mode === 'push' ? 'Request upload' : 'Sync now'}</button>
        <button class="btn sm" data-a="edit">Edit</button>
        <button class="btn sm" data-a="upload">Upload employees</button>
        ${d.mode === 'pull' ? '<button class="btn sm" data-a="users">Device users</button><button class="btn sm" data-a="time">Sync time</button>' : '<button class="btn sm" data-a="time">Re-sync clock</button><button class="btn sm" data-a="reupload">Re-upload all</button><button class="btn sm" data-a="cmds">Commands</button>'}
        <button class="btn sm" data-a="logs">Log</button>
        <button class="btn sm" data-a="restart">Restart</button>
        <button class="btn sm danger" data-a="clear">Clear logs</button>
        <button class="btn sm danger" data-a="delete">Delete</button>
      </div></td></tr>`))}`;

  $('#addBtn').onclick = async () => {
    const r = await formModal('Add device', deviceFields(), (v) => post('/devices', v));
    if (r) { toast('Device added'); route(); }
  };
  $('#testBtn').onclick = async () => {
    const r = await formModal('Test TCP/IP connection', [
      { name: 'ip', label: 'IP address', required: true }, { name: 'port', label: 'Port', type: 'number', value: 4370 },
      { name: 'comm_key', label: 'Comm key', type: 'number', value: 0 }, { name: 'transport', label: 'Protocol', type: 'select', options: [['tcp', 'TCP'], ['udp', 'UDP']] },
    ], (v) => post('/devices/test', v), 'Connect');
    if (r) showDetails('Device found', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`);
  };

  el.querySelectorAll('.btns button').forEach((btn) => {
    btn.onclick = async () => {
      const { id, mode } = btn.parentElement.dataset;
      const dev = list.find((x) => String(x.id) === id);
      switch (btn.dataset.a) {
        case 'sync': await act(btn, () => post(`/devices/${id}/sync`)); return route();
        case 'time':
          if (mode === 'push' && !confirm('ADMS machines take the time from the server when they connect. Restart this machine now to correct its clock? Punches are not lost.')) return;
          await act(btn, () => post(`/devices/${id}/time`));
          return route();
        case 'reupload': return act(btn, () => post(`/devices/${id}/reupload`));
        case 'restart': if (confirm('Restart the device?')) await act(btn, () => post(`/devices/${id}/restart`)); return;
        case 'clear':
          if (confirm(mode === 'pull' ? 'Download all logs, then erase them from the device?' : 'Queue CLEAR LOG for this device? Make sure all logs were received first.')) {
            await act(btn, () => post(`/devices/${id}/clear-logs`)); route();
          }
          return;
        case 'delete':
          if (confirm(`Delete device "${dev.name}"? Punches already downloaded are kept.`)) { await act(btn, () => del(`/devices/${id}`), 'Device deleted'); route(); }
          return;
        case 'edit': {
          const r = await formModal(`Edit ${dev.name}`, deviceFields(dev), (v) => put(`/devices/${id}`, v));
          if (r) { toast('Saved'); route(); }
          return;
        }
        case 'upload': {
          const r = await formModal('Upload employees to device', [
            { name: 'codes', label: 'Employee codes (comma separated, blank = all active employees)', full: true },
            { type: 'html', html: 'Only the user record (ID, name, card) is sent. Fingerprint / face must be enrolled on the device.' },
          ], (v) => post(`/devices/${id}/upload-employees`, { codes: v.codes ? v.codes.split(',').map((s) => s.trim()).filter(Boolean) : null }), 'Upload');
          if (r) toast(r.queued ? `${r.total} employee(s) queued for the device` : `Uploaded ${r.total - r.failed.length}/${r.total}${r.failed.length ? ` – failed: ${r.failed.map((f) => f.code).join(', ')}` : ''}`, !!r.failed.length);
          return;
        }
        case 'users': {
          const users = await act(btn, () => get(`/devices/${id}/users`));
          if (users) showDetails(`Users on ${dev.name} (${users.length})`, table(['UID', 'User ID', 'Name', 'Card', 'Privilege'], users.map((u) => `<tr><td>${u.uid}</td><td>${esc(u.userId)}</td><td>${esc(u.name)}</td><td>${u.card || ''}</td><td>${u.privilege ? 'Admin' : 'User'}</td></tr>`)));
          return;
        }
        case 'logs': {
          const logs = await get(`/devices/${id}/logs`);
          return showDetails(`Activity – ${dev.name}`, table(['Time', 'Message'], logs.map((l) => `<tr><td>${esc(l.created_at)}</td><td class="${l.level === 'error' ? 'bad' : ''}" style="white-space:normal">${esc(l.message)}</td></tr>`)));
        }
        case 'cmds': {
          const cmds = await get(`/devices/${id}/commands`);
          const r = await formModal(`Commands – ${dev.name}`, [
            { type: 'html', html: table(['#', 'Command', 'Status', 'Created'], cmds.map((c) => `<tr><td>${c.id}</td><td>${esc(c.command.slice(0, 60))}</td><td>${esc(c.status)} ${esc(c.result || '')}</td><td>${esc(c.created_at)}</td></tr>`)) },
            { name: 'command', label: 'Queue a raw ADMS command (e.g. INFO, CHECK, REBOOT)', full: true },
          ], (v) => (v.command ? post(`/devices/${id}/commands`, v) : {}), 'Queue');
          if (r?.id) toast('Command queued');
          return;
        }
        default:
      }
    };
  });
};

// --------------------------------------------------------------- employees
async function employeeFields(e = {}) {
  return [
    { name: 'code', label: 'Employee code (= device User ID)', value: e.code, required: true },
    { name: 'name', label: 'Name', value: e.name, required: true },
    { name: 'department', label: 'Department', value: e.department },
    { name: 'designation', label: 'Designation', value: e.designation },
    { name: 'phone', label: 'Phone', value: e.phone },
    { name: 'email', label: 'Email', type: 'email', value: e.email },
    { name: 'card_no', label: 'Card number', value: e.card_no },
    { name: 'shift_id', label: 'Shift', type: 'select', value: e.shift_id ?? '', options: await shiftOptions() },
    { name: 'join_date', label: 'Joining date', type: 'date', value: e.join_date },
    { name: 'active', label: 'Active', type: 'checkbox', value: e.active ?? 1 },
  ];
}

views.employees = async (el) => {
  el.innerHTML = `
    <div class="toolbar"><h1>Employees</h1><span class="spacer"></span>
      <label>Search<input id="q" placeholder="code / name / dept"></label>
      <label>Status<select id="active"><option value="1">Active</option><option value="0">Inactive</option><option value="">All</option></select></label>
      <button class="btn" id="copyBtn" disabled title="Tick employees first">Transfer to machines</button>
      <button class="btn" id="importBtn">Import CSV</button>
      <button class="btn primary" id="addBtn">Add employee</button></div>
    <div id="list"></div>`;
  shiftsCache = null;
  const selected = new Set();
  const syncSelection = () => {
    $('#copyBtn').disabled = !selected.size;
    $('#copyBtn').textContent = selected.size ? `Transfer to machines (${selected.size})` : 'Transfer to machines';
  };
  const load = async () => {
    const [list, bio] = await Promise.all([
      get(`/employees?q=${encodeURIComponent($('#q').value)}&active=${$('#active').value}`),
      get('/biometrics/summary'),
    ]);
    const bioCell = (code) => {
      const b = bio[code];
      if (!b) return '<span class="muted">–</span>';
      const parts = [b.finger && `FP ${b.finger}`, b.face && `Face ${b.face}`, b.palm && `Palm ${b.palm}`, b.other && `Other ${b.other}`].filter(Boolean);
      return `<a href="#" data-a="bio" data-code="${esc(code)}">${parts.join(' · ')}</a>`;
    };
    $('#list').innerHTML = table([`<input type="checkbox" id="selAll" title="Select all">`, 'Code', 'Name', 'Department', 'Designation', 'Shift', 'Card', 'Biometrics', 'Joined', ''], list.map((e) => `<tr>
      <td><input type="checkbox" class="sel" value="${esc(e.code)}" ${selected.has(e.code) ? 'checked' : ''}></td>
      <td>${esc(e.code)}</td><td>${esc(e.name)}${e.active ? '' : ' <span class="muted">(inactive)</span>'}</td><td>${esc(e.department || '')}</td><td>${esc(e.designation || '')}</td>
      <td>${esc(e.shift_name || 'Default')}</td><td>${esc(e.card_no || '')}</td><td>${bioCell(e.code)}</td><td>${esc(e.join_date || '')}</td>
      <td class="actions"><button class="btn sm" data-id="${e.id}" data-a="edit">Edit</button>
        <a class="btn sm" href="#daily" data-code="${esc(e.code)}" data-a="report">Report</a>
        <button class="btn sm danger" data-id="${e.id}" data-a="delete">Delete</button></td></tr>`));
    const boxes = [...$('#list').querySelectorAll('input.sel')];
    $('#selAll').checked = boxes.length > 0 && boxes.every((b) => b.checked);
    $('#selAll').onchange = (ev) => {
      boxes.forEach((b) => { b.checked = ev.target.checked; if (b.checked) selected.add(b.value); else selected.delete(b.value); });
      syncSelection();
    };
    boxes.forEach((b) => (b.onchange = () => {
      if (b.checked) selected.add(b.value); else selected.delete(b.value);
      $('#selAll').checked = boxes.every((x) => x.checked);
      syncSelection();
    }));
    syncSelection();
    $('#list').querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = async (ev) => {
        const emp = list.find((x) => String(x.id) === b.dataset.id);
        if (b.dataset.a === 'edit') {
          const r = await formModal(`Edit ${emp.name}`, await employeeFields(emp), (v) => put(`/employees/${emp.id}`, { ...v, shift_id: v.shift_id || null }));
          if (r) { toast('Saved'); load(); }
        } else if (b.dataset.a === 'delete') {
          if (confirm(`Delete ${emp.name}? Consider marking inactive instead to keep reports.`)) { await act(b, () => del(`/employees/${emp.id}`), 'Deleted'); load(); }
        } else if (b.dataset.a === 'report') {
          ev.preventDefault();
          employeeReport(b.dataset.code);
        } else if (b.dataset.a === 'bio') {
          ev.preventDefault();
          if (await biometricDetails(b.dataset.code)) load();
        }
      };
    });
  };
  $('#copyBtn').onclick = async () => {
    if (await copyBiometrics([...selected])) load();
  };
  $('#q').oninput = () => { clearTimeout(load.t); load.t = setTimeout(load, 250); };
  $('#active').onchange = load;
  $('#addBtn').onclick = async () => {
    const r = await formModal('Add employee', await employeeFields(), (v) => post('/employees', { ...v, shift_id: v.shift_id || null }));
    if (r) { toast('Employee added'); load(); }
  };
  $('#importBtn').onclick = async () => {
    const r = await formModal('Import employees', [
      { type: 'html', html: 'Paste CSV with a header row. Columns: <code>code,name,department,designation,phone,email,card_no,join_date</code> (code and name required). Existing codes are updated.' },
      { name: 'csv', label: 'CSV', type: 'textarea', full: true, placeholder: 'code,name,department\n101,Asha Verma,Accounts' },
    ], (v) => post('/employees/bulk', parseCsv(v.csv)), 'Import');
    if (r) { toast(`Imported ${r.imported}${r.errors.length ? `, ${r.errors.length} errors (row ${r.errors[0].row}: ${r.errors[0].error})` : ''}`, !!r.errors.length); load(); }
  };
  load();
};

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) throw new Error('CSV is empty');
  const keys = head.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()]).filter(([, v]) => v !== '')));
}

async function employeeReport(code) {
  const from = `${thisMonth()}-01`;
  const r = await act(null, () => get(`/reports/employee?code=${encodeURIComponent(code)}&from=${from}&to=${today()}`));
  if (!r) return;
  const s = r.summary;
  showDetails(`${r.employee.name} (${r.employee.code}) – this month`,
    `<p>Present ${s.present} · Absent ${s.absent} · Leave ${s.leave} · Late ${s.late} · Work ${dur(s.workMin)} h · OT ${dur(s.otMin) || '0'} h</p>` +
    table(['Date', 'Status', 'In', 'Out', 'Hours', 'Late', 'Punches'], r.days.map((d) => `<tr><td>${d.date}</td><td>${badge(d.status)}</td><td>${esc(d.inTime || '')}</td><td>${esc(d.outTime || '')}</td><td>${dur(d.workMin)}</td><td>${d.lateMin || ''}</td><td>${esc((d.punches || []).join(' '))}</td></tr>`)));
}

// -------------------------------------------------------------- biometrics
const BIO_LABEL = { finger: 'Fingerprint', face: 'Face', palm: 'Palm', other: 'Other' };
/** "FP alg 10 · Face alg 7" for devices that reported their matching algorithm versions. */
const algText = (d) => [d.fp_version && `FP alg ${d.fp_version}`, d.face_version && `Face alg ${d.face_version}`].filter(Boolean).join(' · ');

/** Lists the templates stored for one employee; offers to delete them. Resolves true if deleted. */
async function biometricDetails(code) {
  const rows = await get(`/biometrics/${encodeURIComponent(code)}`);
  const r = await formModal(`Stored biometrics – ${code}`, [
    { type: 'html', html: table(['Type', 'Index', 'Size', 'From device', 'Updated'], rows.map((x) => `<tr><td>${BIO_LABEL[x.category]}</td><td>${x.kind === 'bio' ? Math.floor(x.idx / 100) : x.idx}</td><td>${x.size} chars</td><td>${esc(x.device_name || '')}</td><td>${esc(x.updated_at)}</td></tr>`)) },
    { type: 'html', html: 'These are copies kept by the app so they can be sent to other machines. Deleting them here does not remove anything from the machines.' },
  ], null, 'Delete stored copies');
  if (!r) return false;
  if (!confirm(`Delete the stored biometric templates of ${code}?`)) return false;
  return !!(await act(null, () => del(`/biometrics/${encodeURIComponent(code)}`), (x) => `Deleted ${x.removed} template(s)`));
}

/** Copy dialog for the selected employees. Resolves with the result, or null when cancelled. */
async function copyBiometrics(codes) {
  const devs = (await get('/devices')).filter((d) => d.enabled);
  if (devs.length < 1) { toast('Add a device first', true); return null; }
  const label = (d) => `${d.name} (${[d.mode === 'push' ? 'ADMS' : 'TCP/IP', algText(d) || 'algorithm not reported'].join(' · ')})`;
  const res = await formModal(`Transfer ${codes.length} employee(s) to machines`, [
    { type: 'html', html: `<b>Selected:</b> ${esc(codes.join(', '))}` },
    { name: 'sourceDeviceId', label: 'Take biometrics from', type: 'select', value: '', full: true, options: [['', 'Templates already stored in the app (from any machine)'], ...devs.map((d) => [d.id, label(d)])],
      help: 'A TCP/IP machine is read now. An ADMS machine sends templates by itself when someone is enrolled; use <i>Re-upload all</i> on the Devices page to collect ones enrolled earlier.' },
    { name: 'types', label: 'Biometrics to include', type: 'checks', value: ['finger', 'face'], options: [['finger', 'Fingerprints'], ['face', 'Face'], ['palm', 'Palm']],
      help: 'The user record (ID, name, card number) is always transferred, even when no biometric can be.' },
    { name: 'targetDeviceIds', label: 'Transfer to', type: 'checks', value: [], options: devs.map((d) => [d.id, label(d)]),
      help: 'The employee is created on the target if missing. TCP/IP targets receive fingerprints only; face and palm need an ADMS target.' },
    { type: 'html', html: '<b>Compatibility:</b> templates work only between machines that use the same algorithm version (shown in brackets). Templates whose version differs from a target are skipped; when a version is not reported, they are sent with a warning. Sync a TCP/IP machine once to read its versions.' },
    { name: 'force', label: 'Different versions', type: 'checks', value: [], options: [['1', 'Send even when versions differ (not recommended: the machine may accept them but never match)']] },
  ], (v) => {
    if (!v.targetDeviceIds.length) throw new Error('Choose at least one machine under "Transfer to"');
    if (!v.types.length) throw new Error('Choose at least one biometric type (the user record is always sent)');
    if (v.sourceDeviceId && v.targetDeviceIds.includes(String(v.sourceDeviceId))) throw new Error('The source machine cannot also be a target');
    return post('/biometrics/copy', { codes, sourceDeviceId: v.sourceDeviceId || null, targetDeviceIds: v.targetDeviceIds.map(Number), types: v.types, force: v.force.includes('1') });
  }, 'Transfer');
  if (!res) return null;
  const STATUS = {
    copied: '<span class="ok">Copied</span>',
    queued: '<span class="ok">Queued</span>',
    user: '<span class="ok">User copied</span>',
    'user-queued': '<span class="ok">User queued</span>',
    skipped: '<span class="warn">Skipped</span>',
  };
  const what = (e) => [e.finger && `FP ${e.finger}`, e.face && `Face ${e.face}`, e.palm && `Palm ${e.palm}`].filter(Boolean).join(' · ');
  const rows = [];
  for (const d of res.results) {
    if (!d.ok) { rows.push(`<tr><td>${esc(d.device)}</td><td colspan="3" class="bad" style="white-space:normal">${esc(d.error)}</td></tr>`); continue; }
    for (const e of d.employees) rows.push(`<tr><td>${esc(d.device)}</td><td>${esc(e.code)}</td><td>${STATUS[e.status] || esc(e.status)} ${esc(what(e))}</td><td style="white-space:normal">${esc(e.note || '')}</td></tr>`);
  }
  await showDetails('Transfer result', `${res.fetched ? `<p>${esc(res.fetched.message)}</p>` : ''}${table(['Target', 'Employee', 'Result', 'Note'], rows)}
    <p class="help">"Queued" means an ADMS machine receives the data when it next connects (usually within a minute); see Devices → Commands.</p>`);
  return res;
}

// ----------------------------------------------------------------- punches
views.punches = async (el) => {
  const devs = await get('/devices');
  el.innerHTML = `
    <div class="toolbar"><h1>Punch Logs</h1><span class="spacer"></span>
      <label>From<input type="date" id="from" value="${today()}"></label>
      <label>To<input type="date" id="to" value="${today()}"></label>
      <label>Employee code<input id="code" size="8"></label>
      <label>Device<select id="device"><option value="">All</option>${devs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>
      <button class="btn" id="go">Show</button><button class="btn" id="csv">CSV</button>
      <button class="btn primary" id="manual">Manual punch</button></div>
    <div id="list"></div>`;
  const qs = () => `from=${$('#from').value}&to=${$('#to').value}&code=${encodeURIComponent($('#code').value)}&device=${$('#device').value}`;
  const load = async () => {
    const { total, rows } = await get(`/punches?${qs()}&limit=1000`);
    $('#list').innerHTML = `<p class="muted">${total} punches${total > rows.length ? ` (showing latest ${rows.length}, export CSV for all)` : ''}</p>` +
      table(['Time', 'Code', 'Name', 'Department', 'Device', 'State', 'Verify', ''], rows.map((p) => `<tr><td>${esc(p.punch_time)}</td><td>${esc(p.employee_code)}</td><td>${esc(p.employee_name)}</td><td>${esc(p.department || '')}</td>
        <td>${esc(p.device_name || (p.source === 'manual' ? 'Manual' : ''))}</td><td>${esc(PUNCH[p.punch_state] ?? '')}</td><td>${esc(VERIFY[p.verify_type] ?? p.verify_type ?? '')}</td>
        <td>${p.source === 'manual' ? `<button class="btn sm danger" data-id="${p.id}" title="${esc(p.note || '')}">Delete</button>` : ''}</td></tr>`));
    $('#list').querySelectorAll('button[data-id]').forEach((b) => (b.onclick = async () => {
      if (confirm('Delete this manual punch?')) { await act(b, () => del(`/punches/${b.dataset.id}`), 'Deleted'); load(); }
    }));
  };
  $('#go').onclick = load;
  $('#csv').onclick = () => (location.href = `/api/punches.csv?${qs()}`);
  $('#manual').onclick = async () => {
    const r = await formModal('Add manual punch', [
      { name: 'employee_code', label: 'Employee code', required: true },
      { name: 'punch_time', label: 'Date & time', type: 'datetime-local', required: true },
      { name: 'note', label: 'Reason', full: true },
    ], (v) => post('/punches', { ...v, punch_time: v.punch_time.replace('T', ' ') }));
    if (r) { toast('Punch added'); load(); }
  };
  load();
};

// ------------------------------------------------------------ daily report
views.daily = async (el) => {
  el.innerHTML = `
    <div class="toolbar"><h1>Daily Attendance</h1><span class="spacer"></span>
      <label>Date<input type="date" id="date" value="${today()}"></label>
      ${await departmentSelect()}
      <label>Status<select id="status"><option value="">All</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}<option value="LATE">Late</option></select></label>
      <button class="btn" id="go">Show</button><button class="btn" id="csv">CSV</button></div>
    <div id="sum"></div><div id="list"></div>`;
  const qs = () => `date=${$('#date').value}&department=${encodeURIComponent($('#dept').value)}`;
  const load = async () => {
    const { rows } = await get(`/reports/daily?${qs()}`);
    const st = $('#status').value;
    const shown = rows.filter((r) => !st || (st === 'LATE' ? r.lateMin > 0 : r.status === st));
    const count = (s) => rows.filter((r) => r.status === s).length;
    $('#sum').innerHTML = `<p>${Object.keys(STATUS).map((s) => `${badge(s)} ${count(s)}`).join(' &nbsp; ')} &nbsp; Late ${rows.filter((r) => r.lateMin > 0).length}</p>`;
    $('#list').innerHTML = table(['Code', 'Name', 'Department', 'Shift', 'Status', 'In', 'Out', 'Hours', 'Late', 'Early', 'OT', 'Punches', 'Remark'], shown.map((r) => `<tr>
      <td>${esc(r.employee.code)}</td><td>${esc(r.employee.name)}</td><td>${esc(r.employee.department || '')}</td><td>${esc(r.employee.shift_name || '')}</td>
      <td>${badge(r.status)}</td><td>${esc(r.inTime || '')}</td><td>${esc(r.outTime || '')}</td><td>${dur(r.workMin)}</td>
      <td class="${r.lateMin ? 'bad' : ''}">${r.lateMin ? `${r.lateMin}m` : ''}</td><td>${r.earlyMin ? `${r.earlyMin}m` : ''}</td><td>${dur(r.otMin)}</td>
      <td>${esc((r.punches || []).join(' '))}</td><td>${esc(r.remark || '')}</td></tr>`));
  };
  ['#go'].forEach((s) => ($(s).onclick = load));
  $('#date').onchange = load; $('#dept').onchange = load; $('#status').onchange = load;
  $('#csv').onclick = () => (location.href = `/api/reports/daily.csv?${qs()}`);
  load();
};

// ---------------------------------------------------------- monthly muster
views.monthly = async (el) => {
  el.innerHTML = `
    <div class="toolbar"><h1>Monthly Muster Roll</h1><span class="spacer"></span>
      <label>Month<input type="month" id="month" value="${thisMonth()}"></label>
      ${await departmentSelect()}
      <button class="btn" id="go">Show</button><button class="btn" id="csv">CSV / Excel</button></div>
    <p class="help">${Object.entries(STATUS).map(([k, v]) => `${badge(k)} ${v}`).join(' &nbsp; ')}</p>
    <div id="list"></div>`;
  const qs = () => `month=${$('#month').value}&department=${encodeURIComponent($('#dept').value)}`;
  const load = async () => {
    const m = await get(`/reports/monthly?${qs()}`);
    const heads = ['Code', 'Name', ...m.dates.map((d) => `${d.slice(8)}<br><span class="muted">${'SMTWTFS'[new Date(`${d}T00:00:00`).getDay()]}</span>`), 'P', 'A', 'L', 'WO', 'HO', 'Late', 'Payable', 'Hours', 'OT'];
    $('#list').innerHTML = table(heads, m.rows.map(({ employee: e, days, summary: s }) => `<tr><td>${esc(e.code)}</td><td>${esc(e.name)}</td>
      ${days.map((d) => `<td class="${d.status ? `s-${d.status}` : ''}" title="${esc(d.date)} ${esc(d.inTime || '')}-${esc(d.outTime || '')} ${esc(d.remark || '')}">${esc(d.status)}${d.lateMin ? '*' : ''}</td>`).join('')}
      <td>${s.present}</td><td>${s.absent}</td><td>${s.leave}</td><td>${s.weeklyOff}</td><td>${s.holiday}</td><td>${s.late}</td><td><b>${s.payableDays}</b></td><td>${dur(s.workMin)}</td><td>${dur(s.otMin)}</td></tr>`), 'muster') +
      '<p class="help">* = late arrival. Hover a cell for in/out times.</p>';
  };
  $('#go').onclick = load; $('#month').onchange = load; $('#dept').onchange = load;
  $('#csv').onclick = () => (location.href = `/api/reports/monthly.csv?${qs()}`);
  load();
};

// ------------------------------------------------------------------ leaves
views.leaves = async (el) => {
  el.innerHTML = `
    <div class="toolbar"><h1>Leaves</h1><span class="spacer"></span>
      <label>Month<input type="month" id="month" value="${thisMonth()}"></label>
      <button class="btn primary" id="addBtn">Add leave</button></div><div id="list"></div>`;
  const load = async () => {
    const list = await get(`/leaves?month=${$('#month').value}`);
    $('#list').innerHTML = table(['Code', 'Name', 'From', 'To', 'Type', 'Reason', ''], list.map((l) => `<tr><td>${esc(l.employee_code)}</td><td>${esc(l.employee_name || '')}</td><td>${l.from_date}</td><td>${l.to_date}</td><td>${esc(l.leave_type)}</td><td>${esc(l.reason || '')}</td>
      <td><button class="btn sm danger" data-id="${l.id}">Delete</button></td></tr>`));
    $('#list').querySelectorAll('button[data-id]').forEach((b) => (b.onclick = async () => {
      if (confirm('Delete leave?')) { await act(b, () => del(`/leaves/${b.dataset.id}`), 'Deleted'); load(); }
    }));
  };
  $('#month').onchange = load;
  $('#addBtn').onclick = async () => {
    const r = await formModal('Add leave', [
      { name: 'employee_code', label: 'Employee code', required: true },
      { name: 'leave_type', label: 'Type', type: 'select', options: [['CL', 'Casual (CL)'], ['SL', 'Sick (SL)'], ['EL', 'Earned (EL)'], ['OD', 'On Duty (OD)'], ['LWP', 'Leave without pay']] },
      { name: 'from_date', label: 'From', type: 'date', required: true, value: today() },
      { name: 'to_date', label: 'To', type: 'date', required: true, value: today() },
      { name: 'reason', label: 'Reason', full: true },
    ], (v) => post('/leaves', v));
    if (r) { toast('Leave added'); load(); }
  };
  load();
};

// ------------------------------------------------------------------ shifts
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const shiftFields = (s = {}) => [
  { name: 'name', label: 'Name', value: s.name, required: true },
  { name: 'start_time', label: 'Start', type: 'time', value: s.start_time || '09:30', required: true },
  { name: 'end_time', label: 'End', type: 'time', value: s.end_time || '18:30', required: true },
  { name: 'grace_minutes', label: 'Late grace (min)', type: 'number', value: s.grace_minutes ?? 15 },
  { name: 'early_exit_grace', label: 'Early exit grace (min)', type: 'number', value: s.early_exit_grace ?? 15 },
  { name: 'half_day_minutes', label: 'Min. minutes for half day', type: 'number', value: s.half_day_minutes ?? 240 },
  { name: 'full_day_minutes', label: 'Min. minutes for full day', type: 'number', value: s.full_day_minutes ?? 480 },
  { name: 'weekly_off', label: 'Weekly off (0=Sun … 6=Sat, comma separated)', value: s.weekly_off ?? '0' },
  { name: 'ot_enabled', label: 'Calculate overtime', type: 'checkbox', value: s.ot_enabled },
  { type: 'html', html: 'Night shifts are supported: if End is before Start the shift ends the next day. Punches are assigned to the day starting 4 h before shift start.' },
];

views.shifts = async (el) => {
  const list = await get('/shifts');
  shiftsCache = list;
  el.innerHTML = `<div class="toolbar"><h1>Shifts</h1><span class="spacer"></span><button class="btn primary" id="addBtn">Add shift</button></div>
    ${table(['Name', 'Timing', 'Grace', 'Half / Full day', 'Weekly off', 'OT', 'Employees', ''], list.map((s, i) => `<tr><td>${esc(s.name)}${i === 0 ? ' <span class="muted">(default)</span>' : ''}</td><td>${s.start_time} – ${s.end_time}</td><td>${s.grace_minutes}m</td>
      <td>${dur(s.half_day_minutes)} / ${dur(s.full_day_minutes)}</td><td>${esc(String(s.weekly_off || '').split(',').filter(Boolean).map((d) => DAYS[d]).join(', ') || 'None')}</td><td>${s.ot_enabled ? 'Yes' : 'No'}</td><td>${s.employees}</td>
      <td class="actions"><button class="btn sm" data-a="edit" data-id="${s.id}">Edit</button><button class="btn sm danger" data-a="delete" data-id="${s.id}">Delete</button></td></tr>`))}`;
  $('#addBtn').onclick = async () => { if (await formModal('Add shift', shiftFields(), (v) => post('/shifts', v))) { toast('Shift added'); route(); } };
  el.querySelectorAll('td.actions button').forEach((b) => (b.onclick = async () => {
    const s = list.find((x) => String(x.id) === b.dataset.id);
    if (b.dataset.a === 'edit') {
      if (await formModal(`Edit ${s.name}`, shiftFields(s), (v) => put(`/shifts/${s.id}`, v))) { toast('Saved'); route(); }
    } else if (confirm(`Delete shift ${s.name}? Assigned employees fall back to the default shift.`)) {
      await act(b, () => del(`/shifts/${s.id}`), 'Deleted'); route();
    }
  }));
};

// ---------------------------------------------------------------- holidays
views.holidays = async (el) => {
  const year = new Date().getFullYear();
  el.innerHTML = `<div class="toolbar"><h1>Holidays</h1><span class="spacer"></span>
    <label>Year<input type="number" id="year" value="${year}" style="width:90px"></label>
    <button class="btn primary" id="addBtn">Add holiday</button></div><div id="list"></div>`;
  const load = async () => {
    const list = await get(`/holidays?year=${$('#year').value}`);
    $('#list').innerHTML = table(['Date', 'Day', 'Holiday', ''], list.map((h) => `<tr><td>${h.date}</td><td>${DAYS[new Date(`${h.date}T00:00:00`).getDay()]}</td><td>${esc(h.name)}</td>
      <td><button class="btn sm danger" data-id="${h.id}">Delete</button></td></tr>`));
    $('#list').querySelectorAll('button[data-id]').forEach((b) => (b.onclick = async () => { await act(b, () => del(`/holidays/${b.dataset.id}`), 'Deleted'); load(); }));
  };
  $('#year').onchange = load;
  $('#addBtn').onclick = async () => {
    if (await formModal('Add holiday', [{ name: 'date', label: 'Date', type: 'date', required: true }, { name: 'name', label: 'Name', required: true }], (v) => post('/holidays', v))) { toast('Holiday added'); load(); }
  };
  load();
};

// ---------------------------------------------------------------- settings
views.settings = async (el) => {
  el.innerHTML = `<h1>Settings</h1>
    <div class="card section" style="max-width:420px">
      <h2>Change password</h2>
      <form id="pw" style="display:grid;gap:10px">
        <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
        <label>New password<input type="password" name="next" required minlength="6" autocomplete="new-password"></label>
        <button class="btn primary">Update password</button>
      </form>
    </div>
    <div class="card section help">
      <h2>Connecting devices</h2>
      <p><b>TCP/IP (pull)</b> – eSSL Classic (K21, K30, X990, MB160, iClock…) and Orcus terminals listening on port 4370.
      Give the device a static IP, note its Comm Key, then add it under Devices. The server downloads logs automatically on the configured interval.</p>
      <p><b>ADMS / Cloud (push)</b> – devices with "Cloud Server Setting / ADMS" (Orcus and newer Classic firmware). Set server address to this
      machine (<code>${esc(location.hostname)}</code>) and port <code>${esc(location.port || 80)}</code>, disable HTTPS/proxy on the device.
      The device registers itself; enable it under Devices to start accepting data. Works across networks / internet as long as the device can reach this server.</p>
    </div>`;
  $('#pw').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const r = await act(null, () => post('/change-password', { current: f.current.value, next: f.next.value }), 'Password changed – please sign in again');
    if (r) showLogin();
  };
};

boot();
