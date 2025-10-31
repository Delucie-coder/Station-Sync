/* StationSync - script.js (updated)
   - Fixed duplicated functions
   - Added IoT simulation, alerts, simulation controls
   - Kept existing server-backed API usage
*/

const STORAGE_KEY = 'stationsync_v1';
const TOKEN_KEY = 'stationsync_token';
const BROADCAST_KEY = 'stationsync_broadcast';
const FALLBACK_API = 'http://localhost:3000';

let API_BASE = window.location.origin;
let currentUser = null;
let stations = loadData();
let currentPage = 'dashboard';
let iotChart = null;
let iotSimInterval = null;
let iotSimRunning = false;
let iotSimSpeedMs = 5000; // default 5s per tick

// ----- DOM helpers -----
const $ = (id) => document.getElementById(id);
function uid(){ return 'ST' + Date.now().toString(36).slice(-6).toUpperCase(); }
function loadData(){ try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch(e){ return []; } }
function saveData(d){ localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); }

// simple escape to avoid XSS
function escapeHtml(str=''){ return String(str).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ----- small on-screen banner -----
function showBanner(message, type='info', opts){
  try{
    let b = document.getElementById('ss-banner');
    if (!b){
      b = document.createElement('div'); b.id='ss-banner';
      b.style.position='fixed'; b.style.top='12px'; b.style.right='12px'; b.style.zIndex=9999;
      b.style.padding='8px 12px'; b.style.borderRadius='8px'; b.style.boxShadow='0 4px 12px rgba(0,0,0,0.12)';
      b.style.fontFamily='system-ui,Arial,sans-serif'; document.body.appendChild(b);
    }
    b.innerHTML = '';
    const text = document.createElement('span'); text.textContent = message; b.appendChild(text);
    if (opts && opts.actionText && typeof opts.onClick === 'function'){
      const act = document.createElement('button'); act.className='btn'; act.style.marginLeft='8px';
      act.textContent = opts.actionText; act.addEventListener('click', opts.onClick); b.appendChild(act);
    }
    b.style.background = type === 'error' ? '#fee2e2' : (type==='warn' ? '#fff7ed' : '#ecfeff');
    b.style.color = '#0f172a';
    setTimeout(()=>{ try{ b.remove(); }catch(e){} }, 4500);
  } catch(e){ console.warn(e); }
}

// ----- API status UI -----
function setApiStatus(isOk, message){
  try{
    const el = $('apiStatus'); const loginEl = $('loginApiStatus');
    const text = message || (isOk ? 'API available' : 'API unreachable');
    const cls = isOk ? 'api-status ok' : 'api-status bad';
    const html = `<span>${escapeHtml(text)}</span><button id="apiRetryBtn" title="Retry">Retry</button>`;
    if (el){ el.className = cls; el.innerHTML = html; const btn = $('apiRetryBtn'); if (btn) btn.addEventListener('click', async ()=>{ setApiStatus(false,'Retrying...'); await probePrimary(); await checkSession(); }); }
    if (loginEl){ loginEl.className = cls; loginEl.innerHTML = html; const btn2 = loginEl.querySelector('#apiRetryBtn'); if (btn2) btn2.addEventListener('click', async ()=>{ setApiStatus(false,'Retrying...'); await probePrimary(); await checkSession(); }); }
  } catch(e){ console.warn('setApiStatus error', e); }
}

// ----- API fetch with fallback -----
async function apiFetch(path, options){
  const primary = API_BASE + path;
  try{
    console.debug('[apiFetch] primary:', primary);
    const res = await fetch(primary, options);
    // If primary responded with 404/405 try fallback
    if (res && (res.status === 404 || res.status === 405)){
      console.warn('[apiFetch] primary returned', res.status, '— switching to fallback', FALLBACK_API);
      API_BASE = FALLBACK_API;
      return await fetch(FALLBACK_API + path, options);
    }
    // If primary returns HTML (some static servers return index.html for unknown paths)
    // detect by content-type and fall back to the real API if not JSON
    try{
      const ct = (res && res.headers && res.headers.get) ? (res.headers.get('content-type') || '') : '';
      if (ct && ct.indexOf('application/json') === -1){
        console.warn('[apiFetch] Primary returned non-JSON content-type:', ct, '— switching to fallback API', FALLBACK_API);
        API_BASE = FALLBACK_API;
        return await fetch(FALLBACK_API + path, options);
      }
    } catch(e){}
    return res;
  } catch(e){
    console.error('[apiFetch] primary fetch failed, switching to fallback:', e && e.message || e);
    API_BASE = FALLBACK_API;
    return fetch(FALLBACK_API + path, options);
  }
}

// ----- Auth helpers -----
function isAuthenticated(){ return currentUser !== null; }
// helper to return auth headers when available
function getAuthHeaders(extra){ const token = localStorage.getItem(TOKEN_KEY); const h = Object.assign({}, extra || {}); if (token) h['Authorization'] = 'Bearer ' + token; return h; }
function showUser(name){ const b = $('userBadge'); if (!b) return; b.textContent = `Signed in: ${name}`; b.classList.remove('hidden'); }
function hideUser(){ const b = $('userBadge'); if (!b) return; b.textContent=''; b.classList.add('hidden'); }
function clearAuth(){ try{ sessionStorage.removeItem('stationsync_auth'); localStorage.removeItem(TOKEN_KEY); }catch(e){} hideUser(); currentUser = null; lockUI(); }

// login/register with server wrappers
async function serverLogin(username, password, remember){
  try{
    console.debug('[serverLogin] API_BASE=', API_BASE, '-> POST /api/login');
    const res = await apiFetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password, remember }) });
    if (!res.ok){
      let bodyText = null;
      try{ bodyText = await res.text(); } catch(e){}
      console.error('[serverLogin] login failed', res.status, bodyText);
      let parsed = null;
      try{ parsed = JSON.parse(bodyText); } catch(e){}
      const message = (parsed && parsed.message) ? parsed.message : (bodyText || 'Login failed');
      throw new Error(message);
    }
    const j = await res.json();
    if (j.token) localStorage.setItem(TOKEN_KEY, j.token);
    currentUser = j.user; showUser(currentUser); localStorage.setItem(BROADCAST_KEY, 'login:' + Date.now());
    console.debug('[serverLogin] login successful for', username);
    return true;
  } catch(err){
    console.error('[serverLogin] error', err && err.message || err);
    throw err;
  }
}
async function serverRegister(username, password, remember){
  const res = await apiFetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password, remember }) });
  if (!res.ok){ const body = await res.json().catch(()=>({message:'Register failed'})); throw new Error(body.message||'Register failed'); }
  const j = await res.json();
  if (j.token) localStorage.setItem(TOKEN_KEY, j.token);
  currentUser = j.user; showUser(currentUser); localStorage.setItem(BROADCAST_KEY, 'login:' + Date.now());
  return true;
}
async function serverLogout(){
  try{ await apiFetch('/api/logout', { method:'POST' }); } catch(e){}
  localStorage.removeItem(TOKEN_KEY); currentUser = null; clearAuth();
  localStorage.setItem(BROADCAST_KEY, 'logout:' + Date.now());
}

// ----- DOM elements -----
const loginScreen = $('loginScreen');
const loginForm = $('loginForm');
const registerCard = $('registerCard');
const registerForm = $('registerForm');
const showRegisterBtn = $('showRegister');
const showLoginBtn = $('showLogin');
// wire download button idempotently so it is safe to call from init() or after panel rerenders
const dlBtn = $('downloadReportBtn');
if (dlBtn && !dlBtn.dataset.downloadBound){ dlBtn.addEventListener('click', downloadReportCSV); dlBtn.dataset.downloadBound = '1'; }
const rememberEl = $('rememberMe');
const authGate = $('authGate');
const authGateLogin = $('authGateLogin');
const appEl = $('app');
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');
const pageTitle = $('pageTitle');
const pageSubtitle = $('pageSubtitle');
const globalSearch = $('globalSearch');
const userBadge = $('userBadge');

const stationsTableBody = document.querySelector('#stationsTable tbody');
const totalStationsEl = $('totalStations');
const activeStationsEl = $('activeStations');
const inactiveStationsEl = $('inactiveStations');
const totalBatteriesEl = $('totalBatteries');

const stationForm = $('stationForm');
const resetFormBtn = $('resetForm');
const locationList = $('locationList');
const maintenancePanelEl = $('maintenancePanel');
const reportsPanelEl = $('reportsPanel');
const reportTableWrapEl = $('reportTableWrap');

// simulation controls: (we add small UI elements into the topbar)
function ensureSimControls(){
  try{
    if ($('simControls')) return;
    const topRight = document.querySelector('.top-right');
    if (!topRight) return;
    const wrapper = document.createElement('div'); wrapper.id='simControls'; wrapper.style.display='flex'; wrapper.style.gap='8px'; wrapper.style.alignItems='center'; wrapper.style.marginLeft='8px';
    const tickBtn = document.createElement('button'); tickBtn.className='btn'; tickBtn.id='iotTickBtn'; tickBtn.textContent='IoT Tick';
    const toggleBtn = document.createElement('button'); toggleBtn.className='btn'; toggleBtn.id='iotToggleBtn'; toggleBtn.textContent='Start Simulation';
    const speedSel = document.createElement('select'); speedSel.id='iotSpeed'; speedSel.innerHTML = '<option value="3000">3s</option><option value="5000" selected>5s</option><option value="10000">10s</option>';
    wrapper.appendChild(tickBtn); wrapper.appendChild(toggleBtn); wrapper.appendChild(speedSel);
    topRight.appendChild(wrapper);
    tickBtn.addEventListener('click', ()=> simulateIoTTick());
    toggleBtn.addEventListener('click', ()=> {
      if (iotSimRunning) stopIoTSimulation(); else startIoTSimulation();
    });
    speedSel.addEventListener('change', (e)=> {
      iotSimSpeedMs = Number(e.target.value) || 5000;
      if (iotSimRunning){ stopIoTSimulation(); startIoTSimulation(); }
    });
  } catch(e){ console.warn(e); }
}

// ----- Navigation -----
function setActiveNav(page){
  if (!isAuthenticated()){
    appEl.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    lockUI();
    return;
  }
  navItems.forEach(btn => btn.classList.toggle('active', btn.dataset.page === page));
  pages.forEach(p => p.classList.toggle('hidden', p.id !== page));
  pageTitle.textContent = page[0].toUpperCase() + page.slice(1);
  pageSubtitle.textContent = page === 'dashboard' ? 'Overview of registered stations' : (page === 'register' ? 'Add a new station' : 'IoT status analytics and distribution');
  currentPage = page;
  render();
  if (page === 'register'){ setTimeout(()=>{ try{ const f = $('stationName'); if (f){ f.focus(); f.scrollIntoView({behavior:'smooth', block:'center'}); } }catch(e){} }, 80); showBanner('Enter station details and click Register Station', 'info'); }
}
navItems.forEach(btn => btn.addEventListener('click', ()=> setActiveNav(btn.dataset.page)));

// global search hook
globalSearch && globalSearch.addEventListener('input', render);

// logout handler
$('logoutBtn') && $('logoutBtn').addEventListener('click', async ()=>{
  try{ await serverLogout(); } catch(e){ clearAuth(); }
  appEl.classList.add('hidden'); loginScreen.classList.remove('hidden'); lockUI();
});

// login/register UI toggles
showRegisterBtn && showRegisterBtn.addEventListener('click', ()=>{
  loginForm.parentElement.classList.add('hidden'); registerCard.classList.remove('hidden');
});
showLoginBtn && showLoginBtn.addEventListener('click', ()=>{
  registerCard.classList.add('hidden'); loginForm.parentElement.classList.remove('hidden');
});
authGateLogin && authGateLogin.addEventListener('click', ()=>{
  registerCard && registerCard.classList.add('hidden');
  if (loginForm && loginForm.parentElement) loginForm.parentElement.classList.remove('hidden');
  loginScreen.classList.remove('hidden'); authGate && authGate.classList.add('hidden');
});

// ----- Login flow -----
if (loginForm){
  loginForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const u = $('loginUser').value.trim(), p = $('loginPass').value.trim(), remember = rememberEl && rememberEl.checked;
    if (!u || !p) return alert('Enter username and password.');
    try{
      await serverLogin(u, p, remember);
      unlockUI(); loginScreen.classList.add('hidden'); appEl.classList.remove('hidden');
      setActiveNav('dashboard');
      window.location.href = 'app.html'; // keep behavior of redirect to app.html
    } catch(err){ // attempt auto-login fallback handled by server auto-login in older flow — keep simple here
      // If server login fails, try auto-login endpoint for dev convenience
      try{
        const listRes = await apiFetch('/api/users');
        if (listRes.ok){
          const lj = await listRes.json();
          if (lj.users && Array.isArray(lj.users) && lj.users.indexOf(u) !== -1){
            // try auto-login
            const auto = await apiFetch('/api/auto-login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: u }) });
            if (auto.ok){
              const j = await auto.json(); if (j.token) localStorage.setItem(TOKEN_KEY, j.token); currentUser = j.user; showUser(currentUser); window.location.href = 'app.html'; return;
            }
          }
        }
      } catch(e){}
      console.error('Login failure:', err);
      showBanner('Login failed: ' + (err.message || 'Unknown error'), 'error');
    }
  });
}

// registration
if (registerForm) registerForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const u = $('regUser').value.trim(), p1 = $('regPass').value, p2 = $('regPass2').value;
  if (!u || !p1) return alert('Choose a username and password.');
  if (p1 !== p2) return alert('Passwords do not match.');
  try{
    await serverRegister(u, p1, true);
    registerCard.classList.add('hidden'); loginForm.parentElement.classList.remove('hidden');
    loginScreen.classList.add('hidden'); appEl.classList.remove('hidden'); unlockUI(); setActiveNav('dashboard');
  } catch(err){ alert(err.message || 'Registration failed'); }
});

// ----- Rendering & Table -----
function render(){
  if (!isAuthenticated()) return;
  // filter
  const q = (globalSearch && globalSearch.value || '').trim().toLowerCase();
  let filtered = stations.filter(s => {
    if (!q) return true;
    return (String(s.name)+' '+String(s.location)+' '+String(s.id)).toLowerCase().includes(q);
  });

  // stats
  if (totalStationsEl) totalStationsEl.textContent = stations.length;
  // active/inactive cards removed from dashboard — only set if elements exist
  if (activeStationsEl) activeStationsEl.textContent = stations.filter(s => s.status === 'Active').length;
  if (inactiveStationsEl) inactiveStationsEl.textContent = stations.filter(s => s.status === 'Inactive').length;
  if (totalBatteriesEl) totalBatteriesEl.textContent = stations.reduce((acc,s)=> acc + (Number(s.batteryCount)||0), 0);

  // table
  stationsTableBody.innerHTML = '';
  filtered.forEach(s=>{
    const tr = document.createElement('tr');
    // alert conditions
    const lowBattery = Number(s.batteryCount) <= 2;
    const offline = s.iotStatus === 'Inactive';
    if (lowBattery || offline) tr.classList.add('row-alert');

    tr.innerHTML = `
      <td>${escapeHtml(s.id)}</td>
      <td>${escapeHtml(s.name)} ${s.guest ? '<span class="guest-badge">(local)</span>' : ''}</td>
      <td>${escapeHtml(s.location)}</td>
      <td>${escapeHtml(s.type)}</td>
      <td>${Number(s.batteryCount)}</td>
      <td>
        <button class="btn" data-action="view" data-id="${s.id}" title="View station"><i class="fa-solid fa-eye"></i></button>
        <button class="btn" data-action="edit" data-id="${s.id}" title="Edit station"><i class="fa-solid fa-pen-to-square"></i></button>
        <button class="btn danger" data-action="delete" data-id="${s.id}" title="Delete station"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    stationsTableBody.appendChild(tr);
  });

  updateChart();
  renderLocations();
}

// normalize server station rows (sqlite uses snake_case column names)
function normalizeStation(s){ if (!s) return s; return {
  id: s.id || s.ID || s.station_id || s.stationId,
  name: s.name || s.station_name || s.stationName || '',
  contact: s.contact || s.phone || '',
  location: s.location || s.loc || '',
  type: s.type || s.station_type || s.type || '',
  batteryCount: (s.batteryCount !== undefined && s.batteryCount !== null) ? Number(s.batteryCount) : (s.battery_count !== undefined ? Number(s.battery_count) : 0),
  status: s.status || s.state || '',
  iotStatus: s.iotStatus || s.iot_status || s.iotState || '',
  createdAt: s.createdAt || s.created_at || ''
}; }

function normalizeRecord(r){ if (!r) return r; return {
  id: r.id || r.ID,
  stationId: r.stationId || r.station_id || r.station,
  date: r.date,
  startOfDay: (r.startOfDay !== undefined) ? r.startOfDay : (r.start_of_day !== undefined ? r.start_of_day : 0),
  givenOut: (r.givenOut !== undefined) ? r.givenOut : (r.given_out !== undefined ? r.given_out : 0),
  remaining: (r.remaining !== undefined) ? r.remaining : (r.remaining !== undefined ? r.remaining : 0),
  needRepair: (r.needRepair !== undefined) ? r.needRepair : (r.need_repair !== undefined ? r.need_repair : 0),
  damaged: (r.damaged !== undefined) ? r.damaged : (r.damaged !== undefined ? r.damaged : 0),
  earnings: (r.earnings !== undefined) ? Number(r.earnings) : (r.earning !== undefined ? Number(r.earning) : (r.earnings_amount !== undefined ? Number(r.earnings_amount) : 0)),
  notes: r.notes || r.note || '',
  createdAt: r.createdAt || r.created_at || '',
  updatedAt: r.updatedAt || r.updated_at || ''
}; }

// Fetch stations from server and normalize them into the local `stations` array
async function fetchStations(){
  if (!isAuthenticated()) return;
  try{
    const headers = getAuthHeaders();
    const res = await apiFetch('/api/stations', { headers });
    if (!res || !res.ok) return;
    const j = await res.json();
    if (j && Array.isArray(j.stations)){
      stations = j.stations.map(normalizeStation);
      saveData(stations);
      render();
    }
  } catch(e){ console.warn('fetchStations error', e); }
}

// highlight row
function highlightStationRow(stationId){
  try{
    const rows = Array.from(document.querySelectorAll('#stationsTable tbody tr'));
    const found = rows.find(r => r.children[0] && r.children[0].textContent.trim() === String(stationId));
    if (!found) return;
    found.classList.add('highlight-row');
    found.scrollIntoView({ behavior:'smooth', block:'center' });
    setTimeout(()=> found.classList.remove('highlight-row'), 2500);
  } catch(e){}
  // wire migration button (if present)
  try{
    const migBtn = $('migrateBtn'); if (migBtn){ migBtn.addEventListener('click', async ()=>{
      if (!confirm('Migrate JSON data to SQLite on the server? This is one-time and requires the server to have SQLite support installed.')) return;
      const statusEl = $('migrateStatus'); if (statusEl) statusEl.textContent = 'Migrating...';
      const token = localStorage.getItem(TOKEN_KEY); const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
      try{
        const res = await apiFetch('/api/migrate-to-sqlite', { method:'POST', headers });
        if (!res.ok) { const txt = await res.text().catch(()=>res.status); if (statusEl) statusEl.textContent = 'Migration failed'; showBanner('Migration failed: ' + txt, 'error'); return; }
        const j = await res.json(); if (statusEl) statusEl.textContent = 'Migration complete'; showBanner('Migration complete', 'info');
      } catch(e){ if (statusEl) statusEl.textContent = 'Migration error'; showBanner('Migration error: ' + (e.message||e), 'error'); }
    }); }
  } catch(e){}
}

// confirm modal
function openConfirmModal(title, html){
  return new Promise((resolve)=>{
    try{
      const modal = $('confirmModal'); const t = $('confirmTitle'); const body = $('confirmBody'); const ok = $('confirmOk'); const cancel = $('confirmCancel');
      if (!modal || !ok || !cancel){ resolve(true); return; }
      t.textContent = title || 'Confirm'; body.innerHTML = html || '';
      modal.classList.remove('hidden');
      const cleanup = ()=> { try{ modal.classList.add('hidden'); }catch(e){}; ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); };
      const onOk = ()=>{ cleanup(); resolve(true); };
      const onCancel = ()=>{ cleanup(); resolve(false); };
      ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel);
    } catch(e){ resolve(true); }
  });
}

// ----- Backups / Restore UI -----
function showBackupsModal(){
  const modal = $('backupsModal'); if (!modal) return;
  modal.classList.remove('hidden');
  const status = $('restoreStatus'); if (status) status.textContent = '';
  loadBackupsList();
}

function closeBackupsModal(){
  const modal = $('backupsModal'); if (!modal) return; modal.classList.add('hidden');
}

async function loadBackupsList(){
  const listEl = $('backupsList'); const status = $('restoreStatus');
  if (!listEl) return;
  listEl.innerHTML = 'Loading...';
  try{
    const token = localStorage.getItem(TOKEN_KEY); const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const res = await apiFetch('/api/list-backups', { headers });
    if (!res.ok){ listEl.innerHTML = '<div class="muted">Failed to list backups</div>'; return; }
    const j = await res.json(); const files = j.backups || [];
    if (!files.length){ listEl.innerHTML = '<div class="muted">No backups available</div>'; return; }
    listEl.innerHTML = '';
    files.forEach(f => {
      const row = document.createElement('div'); row.className = 'backup-row';
      row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.alignItems = 'center'; row.style.padding = '6px 8px'; row.style.borderBottom = '1px solid #eee';
      const name = document.createElement('div'); name.textContent = f; name.style.fontFamily='monospace';
      const actions = document.createElement('div');
      const restoreBtn = document.createElement('button'); restoreBtn.className='btn danger'; restoreBtn.textContent='Restore';
      restoreBtn.addEventListener('click', async ()=>{
        const ok = await openConfirmModal('Restore backup', `<div>Are you sure you want to restore <strong>${escapeHtml(f)}</strong>? This will overwrite server JSON data.</div>`);
        if (!ok) return;
        try{
          if (status) status.textContent = 'Restoring...';
          const rres = await apiFetch('/api/restore-from-backup', { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, headers), body: JSON.stringify({ file: f }) });
          if (!rres.ok){ const t = await rres.text().catch(()=>rres.status); if (status) status.textContent = 'Restore failed'; showBanner('Restore failed: ' + t, 'error'); return; }
          const jr = await rres.json(); if (status) status.textContent = 'Restore complete'; showBanner('Restore complete — reload to apply', 'info', { actionText:'Reload', onClick:()=> location.reload() });
        } catch(e){ if (status) status.textContent = 'Restore error'; showBanner('Restore error: ' + (e.message||e), 'error'); }
      });
      actions.appendChild(restoreBtn);
      row.appendChild(name); row.appendChild(actions);
      listEl.appendChild(row);
    });
  } catch(e){ listEl.innerHTML = '<div class="muted">Error loading backups</div>'; }
}


// ----- Station form submit -----
if (stationForm) stationForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const name = $('stationName').value.trim(); if (!name) { alert('Station name is required'); return; }
  const contact = $('stationContact').value.trim(); const location = $('stationLocation').value.trim();
  const type = $('stationType').value; const batteryCount = Number($('batteryCount').value) || 0;
  const payload = { name, contact, location, type, batteryCount };

  try{
    const previewHtml = `<div><strong>Name:</strong> ${escapeHtml(name)}</div><div><strong>Location:</strong> ${escapeHtml(location)}</div><div><strong>Initial batteries:</strong> ${batteryCount}</div>`;
    const ok = await openConfirmModal(editingStationId ? 'Preview station before updating' : 'Preview station before saving', previewHtml); if (!ok) return;
  } catch(e){}

  if (!isAuthenticated()) return alert('Please sign in before registering a station.');

  try{
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = { 'Content-Type':'application/json' }; if (token) headers['Authorization'] = 'Bearer ' + token;

    if (editingStationId){
      // update existing station
      const res = await apiFetch('/api/stations/' + encodeURIComponent(editingStationId), { method: 'PUT', headers, body: JSON.stringify(payload) });
      if (!res.ok){ const body = await res.json().catch(()=>({message:'Update failed'})); showBanner('Failed to update station: ' + (body.message||res.status), 'error'); return; }
      const j = await res.json();
      // update local list
      const idx = stations.findIndex(s => s.id === editingStationId);
      if (idx !== -1){ stations[idx] = Object.assign({}, stations[idx], payload); saveData(stations); }
      render();
      showBanner('Station updated', 'info');
      editingStationId = null;
      const submitBtn = stationForm && stationForm.querySelector('button[type="submit"]'); if (submitBtn) submitBtn.textContent = 'Register Station';
      stationForm.reset(); setActiveNav('dashboard'); return;
    }

    // create new station
    const res = await apiFetch('/api/stations', { method:'POST', headers, body: JSON.stringify(payload) });
    if (!res.ok){ const body = await res.json().catch(()=>({message:'Failed'})); showBanner('Failed to register station: ' + (body.message||res.status), 'error'); return; }
    const j = await res.json();
    // fetch authoritative list
    try{
      const listRes = await apiFetch('/api/stations', { headers });
      if (listRes && listRes.ok){ const lj = await listRes.json(); if (lj.stations) { stations = lj.stations.map(normalizeStation); saveData(stations); }
      } else {
        if (j && j.station){ stations.push(normalizeStation(j.station)); saveData(stations); }
      }
    } catch(e){ if (j && j.station){ stations.push(j.station); saveData(stations); } }
    render();
    showBanner('Station registered', 'info', { actionText: 'View', onClick: ()=>{ if (j.station && j.station.id) { openStationModal(j.station.id); setActiveNav('dashboard'); highlightStationRow(j.station.id); } } });
    stationForm.reset(); setActiveNav('dashboard');
    setTimeout(()=>{ if (j.station && j.station.id) highlightStationRow(j.station.id); }, 120);
  } catch(err){ showBanner('Error saving station: ' + (err.message||err), 'error'); }
});

resetFormBtn && resetFormBtn.addEventListener('click', ()=>{
  stationForm.reset();
  editingStationId = null;
  const submitBtn = stationForm && stationForm.querySelector('button[type="submit"]'); if (submitBtn) submitBtn.textContent = 'Register Station';
});

// table delegation
document.addEventListener('click', async (e)=>{
  const btn = e.target.closest('button'); if (!btn) return;
  const action = btn.dataset.action; const id = btn.dataset.id; if (!action) return;
  if (!isAuthenticated()){ alert('Please login first.'); return; }
  if (action === 'delete'){
    if (!confirm('Delete station?')) return;
    try{
      if (isAuthenticated()){
        const token = localStorage.getItem(TOKEN_KEY); const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
        const res = await apiFetch('/api/stations/' + encodeURIComponent(id), { method: 'DELETE', headers });
        if (!res.ok){ showBanner('Failed to delete station on server', 'error'); return; }
        // reload authoritative list
        const listRes = await apiFetch('/api/stations', { headers }); if (listRes && listRes.ok){ const lj = await listRes.json(); if (lj.stations) { stations = lj.stations.map(normalizeStation); saveData(stations); } }
      } else {
        stations = stations.filter(s=> s.id !== id); saveData(stations);
      }
      render();
    } catch(e){ showBanner('Delete failed: ' + (e.message||e), 'error'); }
  }
  if (action === 'view'){ openStationModal(id); }
  if (action === 'edit'){ openEditStation(id); }
});

// ----- Chart -----
function updateChart(){
  const statuses = ['Charging','Idle','Active','Under maintenance','Inactive'];
  const counts = statuses.map(st => stations.filter(s => s.iotStatus === st).length);
  const ctx = $('iotChart') && $('iotChart').getContext('2d');
  if (!ctx) return;
  if (iotChart){
    iotChart.data.labels = statuses; iotChart.data.datasets[0].data = counts; iotChart.update(); return;
  }
  iotChart = new Chart(ctx, {
    type:'doughnut',
    data:{ labels: statuses, datasets:[{ data: counts, backgroundColor: ['#06b6b4','#60a5fa','#0ea5a6','#f59e0b','#ef4444'] }] },
    options:{ responsive:true, plugins:{ legend: { position:'bottom' } } }
  });
}

// ----- Locations -----
function renderLocations(){
  const byLocation = {};
  stations.forEach(s=>{ const loc = s.location || 'Unknown'; byLocation[loc] = (byLocation[loc]||0)+1; });
  locationList.innerHTML = '';
  Object.keys(byLocation).forEach(loc=>{
    const div = document.createElement('div'); div.className='location-item'; div.innerHTML = `<strong>${escapeHtml(loc)}</strong> — ${byLocation[loc]} station(s)`; locationList.appendChild(div);
  });
}

// ----- Station modal & records (uses server endpoints) -----
const stationModal = $('stationModal'), closeStationModalBtn = $('closeStationModal');
const modalStationName = $('modalStationName'), modalStationInfo = $('modalStationInfo');
const modalRecordsList = $('modalRecordsList'), recordForm = $('recordForm');

let activeStationId = null, lastLoadedRecords = [], editingRecordId = null;
let editingStationId = null;

function formatDate(iso){ try{ return new Date(iso).toLocaleString(); } catch(e){ return iso; } }

function openStationModal(id){
  activeStationId = id;
  const st = stations.find(s=>s.id===id);
  if (!st) return alert('Station not found');
  modalStationName.textContent = st.name;
  modalStationInfo.innerHTML = `<strong>Location:</strong> ${escapeHtml(st.location)} — <strong>Contact:</strong> ${escapeHtml(st.contact)}<br/><strong>Type:</strong> ${escapeHtml(st.type)} — <strong>Batteries:</strong> ${st.batteryCount}`;
  modalRecordsList.innerHTML = '<em>Loading records...</em>';
  stationModal.classList.remove('hidden');
  try{
    const today = new Date(); const iso = today.toISOString().slice(0,10);
    const recDateEl = $('recDate'); const fromEl = $('recFrom'); const toEl = $('recTo');
    if (recDateEl) recDateEl.value = iso;
    if (toEl) toEl.value = iso;
    if (fromEl){ const past = new Date(); past.setDate(past.getDate() - 30); fromEl.value = past.toISOString().slice(0,10); }
    // wire quick range buttons (replace handlers)
    const b30 = $('range30'); const bm = $('rangeMonth'); const by = $('rangeYear');
    if (b30) b30.onclick = ()=>{ const to = new Date(); const from = new Date(); from.setDate(from.getDate()-30); $('recFrom').value = from.toISOString().slice(0,10); $('recTo').value = to.toISOString().slice(0,10); loadStationRecords(id, $('recFrom').value, $('recTo').value); };
    if (bm) bm.onclick = ()=>{ const now = new Date(); const from = new Date(now.getFullYear(), now.getMonth(), 1); $('recFrom').value = from.toISOString().slice(0,10); $('recTo').value = new Date().toISOString().slice(0,10); loadStationRecords(id, $('recFrom').value, $('recTo').value); };
    if (by) by.onclick = ()=>{ const now = new Date(); const from = new Date(now.getFullYear(), 0, 1); $('recFrom').value = from.toISOString().slice(0,10); $('recTo').value = new Date().toISOString().slice(0,10); loadStationRecords(id, $('recFrom').value, $('recTo').value); };
    // add Export CSV button to modal controls (if not present)
    try{
      if (!$('exportCsvBtn')){
        const ctrlWrap = b30 && b30.parentElement ? b30.parentElement : null;
        const expBtn = document.createElement('button'); expBtn.id = 'exportCsvBtn'; expBtn.className = 'btn'; expBtn.textContent = 'Export CSV';
        expBtn.style.marginLeft = '8px';
        expBtn.addEventListener('click', ()=> exportCsvForActiveStation());
        if (ctrlWrap) ctrlWrap.appendChild(expBtn);
      }
    } catch(e){}
    if (fromEl) fromEl.onchange = ()=> loadStationRecords(id, fromEl.value, toEl ? toEl.value : '');
    if (toEl) toEl.onchange = ()=> loadStationRecords(id, fromEl ? fromEl.value : '', toEl.value);
  } catch(e){}
  const f = $('recFrom') && $('recFrom').value; const t = $('recTo') && $('recTo').value;
  loadStationRecords(id, f, t);
  
}
// Open register form prefilled for editing an existing station
function openEditStation(id){
  const st = stations.find(s => s.id === id);
  if (!st) return alert('Station not found');
  editingStationId = id;
  // Prefill the register form
  setActiveNav('register');
  setTimeout(()=>{
    try{
      const name = $('stationName'); const contact = $('stationContact'); const location = $('stationLocation'); const type = $('stationType'); const battery = $('batteryCount');
      if (name) name.value = st.name || '';
      if (contact) contact.value = st.contact || '';
      if (location) location.value = st.location || '';
      if (type) type.value = st.type || '';
      if (battery) battery.value = Number(st.batteryCount) || 0;
      const submitBtn = stationForm && stationForm.querySelector('button[type="submit"]'); if (submitBtn) submitBtn.textContent = 'Update Station';
    } catch(e){}
  }, 120);
}
function closeStationModal(){ stationModal.classList.add('hidden'); activeStationId = null; modalRecordsList.innerHTML=''; editingRecordId=null; recordForm && recordForm.reset(); }

closeStationModalBtn && closeStationModalBtn.addEventListener('click', closeStationModal);

async function loadStationRecords(stationId, from, to){
  try{
    let url = `/api/stations/${stationId}/records`;
    const params = [];
    if (from) params.push('from=' + encodeURIComponent(from));
    if (to) params.push('to=' + encodeURIComponent(to));
    if (params.length) url += '?' + params.join('&');
    const headers = getAuthHeaders();
    const res = await apiFetch(url, { headers });
    if (!res.ok){ modalRecordsList.innerHTML = '<div class="muted">No records</div>'; return; }
    const j = await res.json(); const recs = j.records || []; lastLoadedRecords = recs.map(normalizeRecord);
    if (recs.length === 0) { modalRecordsList.innerHTML = '<div class="muted">No records</div>'; return; }
    modalRecordsList.innerHTML = '';
    lastLoadedRecords.forEach(r=>{
      const div = document.createElement('div'); div.className='record-item';
      const info = document.createElement('div'); info.className='record-info';
      info.innerHTML = `<strong>${escapeHtml(r.date)}</strong> — Start: ${r.startOfDay}, Given: ${r.givenOut}, Remaining: ${r.remaining}, Repair: ${r.needRepair}, Damaged: ${r.damaged}, Earnings: ${Number(r.earnings||0).toFixed(2)} RWF`;
      const notes = document.createElement('div'); notes.className = 'muted'; notes.textContent = r.notes || '';
      const meta = document.createElement('div'); meta.className = 'muted'; meta.textContent = formatDate(r.createdAt) + (r.updatedAt ? (' • Updated: ' + formatDate(r.updatedAt)) : '');
      const actions = document.createElement('div'); actions.className='record-actions';
      const editBtn = document.createElement('button'); editBtn.className='btn'; editBtn.textContent='Edit';
      const delBtn = document.createElement('button'); delBtn.className='btn danger'; delBtn.textContent='Delete';
      editBtn.addEventListener('click', ()=> startEditRecord(r)); delBtn.addEventListener('click', ()=> deleteRecord(r.id));
      actions.appendChild(editBtn); actions.appendChild(delBtn);
      div.appendChild(info); div.appendChild(notes); div.appendChild(meta); div.appendChild(actions);
      modalRecordsList.appendChild(div);
    });
  } catch(e){ modalRecordsList.innerHTML = '<div class="muted">Failed to load records</div>'; }
}

recordForm && recordForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if (!activeStationId) return alert('No station selected');
  const payload = {
    date: $('recDate').value, startOfDay: Number($('recStart').value)||0, givenOut: Number($('recGiven').value)||0,
    remaining: Number($('recRemaining').value)||0, needRepair: Number($('recRepair').value)||0, damaged: Number($('recDamaged').value)||0, earnings: Number($('recEarnings') ? $('recEarnings').value : 0) || 0, notes: $('recNotes').value||''
  };
  try{
    const headers = getAuthHeaders({'Content-Type':'application/json'});
    if (editingRecordId){
      const res = await apiFetch(`/api/stations/${activeStationId}/records/${editingRecordId}`, { method:'PUT', headers, body: JSON.stringify(payload) });
      if (!res.ok) {
        const txt = await res.text().catch(()=>res.status); throw new Error(txt || 'Update failed');
      }
      showBanner('Record updated', 'info');
      editingRecordId=null; recordForm.reset(); await loadStationRecords(activeStationId); return;
    }
    // duplicate date check
    const dup = lastLoadedRecords.find(r => r.date === payload.date);
    if (dup){
      if (!confirm('A record for this date already exists. Overwrite it?')) return;
      const res = await apiFetch(`/api/stations/${activeStationId}/records/${dup.id}`, { method:'PUT', headers, body: JSON.stringify(payload) });
      if (!res.ok) { const txt = await res.text().catch(()=>res.status); throw new Error(txt || 'Update failed'); }
      showBanner('Record updated', 'info'); recordForm.reset(); await loadStationRecords(activeStationId); return;
    }
    const res = await apiFetch(`/api/stations/${activeStationId}/records`, { method:'POST', headers, body: JSON.stringify(payload) });
    if (!res.ok) { const txt = await res.text().catch(()=>res.status); throw new Error(txt || 'Save failed'); }
    await loadStationRecords(activeStationId); showBanner('Record saved', 'info'); recordForm.reset();
  } catch(err){ showBanner('Failed to save record: ' + (err.message||err), 'error'); }
});

function startEditRecord(record){
  editingRecordId = record.id;
  $('recDate').value = record.date; $('recStart').value = record.startOfDay||0; $('recGiven').value = record.givenOut||0;
  $('recRemaining').value = record.remaining||0; $('recRepair').value = record.needRepair||0; $('recDamaged').value = record.damaged||0; $('recNotes').value = record.notes||'';
  try{ if ($('recEarnings')) $('recEarnings').value = Number(record.earnings||0); } catch(e){}
  const submitBtn = recordForm.querySelector('button[type="submit"]'); if (submitBtn) submitBtn.textContent = 'Update Record';
  showBanner('Editing record — make changes and Save', 'info');
}

async function deleteRecord(rid){
  if (!confirm('Delete this record?')) return;
  try{
    const headers = getAuthHeaders();
    const res = await apiFetch(`/api/stations/${activeStationId}/records/${rid}`, { method:'DELETE', headers });
    if (!res.ok) throw new Error('Delete failed');
    showBanner('Record deleted', 'info'); await loadStationRecords(activeStationId);
  } catch(e){ showBanner('Failed to delete record: ' + (e.message||e), 'error'); }
}

// ----- Maintenance panel and reports -----
async function renderMaintenancePanel(){
  const el = $('maintenanceList'); if (!el) return;
  el.textContent = 'Loading...';
  try{
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const res = await apiFetch('/api/maintenance', { headers });
    if (!res.ok) { el.innerHTML = '<div class="muted">Failed to load maintenance</div>'; if (maintenancePanelEl) maintenancePanelEl.classList.add('hidden'); return; }
    const j = await res.json(); const list = j.maintenance || [];
    if (!list.length){ el.innerHTML = '<div class="muted">No maintenance items</div>'; if (maintenancePanelEl) maintenancePanelEl.classList.add('hidden'); return; }
    if (maintenancePanelEl) maintenancePanelEl.classList.remove('hidden');
    // build table
    const table = document.createElement('table'); table.className='table';
    const thead = document.createElement('thead'); thead.innerHTML = '<tr><th>Station</th><th>Need Repair</th><th>Damaged</th><th>Last Record</th><th>Action</th></tr>';
    const tbody = document.createElement('tbody');
    list.forEach(item=>{
      const tr = document.createElement('tr');
      const st = item.station || { id: item.stationId, name: item.stationId };
      const last = item.lastRecord ? item.lastRecord.date : '';
      tr.innerHTML = `<td>${escapeHtml(st.name)} (${escapeHtml(st.id)})</td><td>${Number(item.needRepair)||0}</td><td>${Number(item.damaged)||0}</td><td>${escapeHtml(last)}</td><td><button class="btn" data-sid="${escapeHtml(st.id)}">View</button></td>`;
      const btn = tr.querySelector('button'); if (btn) btn.addEventListener('click', ()=>{ setActiveNav('dashboard'); openStationModal(st.id); });
      tbody.appendChild(tr);
    });
    table.appendChild(thead); table.appendChild(tbody);
    el.innerHTML = ''; el.appendChild(table);
  } catch(e){ el.innerHTML = '<div class="muted">Error loading maintenance</div>'; }
  // ensure download button is wired even if maintenance panel rerenders
  try{
    const btn = $('downloadReportBtn');
    if (btn && !btn.dataset.downloadBound){ btn.addEventListener('click', downloadReportCSV); btn.dataset.downloadBound = '1'; }
  } catch(e){}
}

let aggregateChart = null;
let lastReportData = null;
// state for report table sorting & pagination
let reportTableState = { sortKey: 'period', sortAsc: false, page: 1, pageSize: 10 };
async function runReport(){
  const period = $('reportPeriod') ? $('reportPeriod').value : 'month';
  const from = $('reportFrom') ? $('reportFrom').value : '';
  const to = $('reportTo') ? $('reportTo').value : '';
  const headers = {};
  const token = localStorage.getItem(TOKEN_KEY); if (token) headers['Authorization'] = 'Bearer ' + token;
  try{
    const q = [];
    if (period) q.push('period=' + encodeURIComponent(period));
    if (from) q.push('from=' + encodeURIComponent(from));
    if (to) q.push('to=' + encodeURIComponent(to));
    const url = '/api/reports/aggregate' + (q.length ? ('?' + q.join('&')) : '');
    const res = await apiFetch(url, { headers });
    if (!res.ok) { showBanner('Failed to load report', 'error'); return; }
  const j = await res.json(); const data = j.data || [];
  lastReportData = { period, from, to, data };
    const labels = data.map(d => d.period);
    const given = data.map(d => Number(d.givenOut)||0);
    const remaining = data.map(d => Number(d.remaining)||0);
    const ctx = $('reportChart') && $('reportChart').getContext ? $('reportChart').getContext('2d') : null;
    if (!ctx) return;
    if (aggregateChart){
      aggregateChart.data.labels = labels;
      aggregateChart.data.datasets[0].data = given;
      aggregateChart.data.datasets[1].data = remaining;
      aggregateChart.update();
      return;
    }
    aggregateChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'Given Out', data: given, backgroundColor: '#60a5fa' },
          { label: 'Remaining', data: remaining, backgroundColor: '#06b6b4' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index' },
        plugins: { legend: { position: 'bottom' } },
        layout: { padding: { top: 6, bottom: 6 } },
        scales: {
          x: {
            stacked: false,
            ticks: { autoSkip: true, maxRotation: 45, minRotation: 0, callback: function(value){ const v = String(this.getLabelForValue(value) || ''); return v.length > 18 ? v.slice(0,16) + '…' : v; } },
            grid: { display: false }
          },
          y: { stacked: false, beginAtZero: true }
        }
      }
    });

    // Render a readable table below the chart for accessibility / clarity (with sorting & pagination)
    try{
      const wrap = reportTableWrapEl || $('reportTableWrap');
      if (wrap){
        if (!Array.isArray(data) || data.length === 0){
          wrap.innerHTML = '<div class="muted">No report data</div>'; wrap.classList.add('hidden');
        } else {
          wrap.classList.remove('hidden');
          // prepare enhanced rows with averages
          const rows = data.map(d => ({ period: d.period, givenOut: Number(d.givenOut||0), remaining: Number(d.remaining||0), count: Number(d.count||0), avgGiven: d.count ? (Number(d.givenOut||0)/Number(d.count||1)) : 0, avgRemaining: d.count ? (Number(d.remaining||0)/Number(d.count||1)) : 0 }));

          // apply sorting
          const sk = reportTableState.sortKey || 'period'; const sa = !!reportTableState.sortAsc;
          rows.sort((a,b) => {
            const av = a[sk]; const bv = b[sk];
            if (typeof av === 'number' && typeof bv === 'number') return sa ? av - bv : bv - av;
            return sa ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
          });

          // pagination
          const pageSize = Number(reportTableState.pageSize) || 10; const page = Number(reportTableState.page) || 1;
          const total = rows.length; const totalPages = Math.max(1, Math.ceil(total / pageSize));
          const start = (page - 1) * pageSize; const end = start + pageSize;
          const pageRows = rows.slice(start, end);

          // build tools: pagination controls + download buttons
          const tools = document.createElement('div'); tools.style.display='flex'; tools.style.justifyContent='space-between'; tools.style.alignItems='center'; tools.style.marginBottom='8px';
          const leftTools = document.createElement('div'); leftTools.style.display='flex'; leftTools.style.alignItems='center'; leftTools.style.gap='8px';
          const perPage = document.createElement('select'); [5,10,20,50].forEach(n=>{ const o = document.createElement('option'); o.value = n; o.textContent = n + ' / page'; if (n===pageSize) o.selected = true; perPage.appendChild(o); });
          perPage.addEventListener('change', ()=>{ reportTableState.pageSize = Number(perPage.value); reportTableState.page = 1; runReport(); });
          leftTools.appendChild(perPage);
          const pageInfo = document.createElement('div'); pageInfo.className='muted'; pageInfo.style.fontSize='0.9rem'; pageInfo.textContent = `Page ${page} of ${totalPages} — ${total} rows`;
          leftTools.appendChild(pageInfo);
          const pager = document.createElement('div'); pager.style.display='flex'; pager.style.gap='8px';
          const prev = document.createElement('button'); prev.className='btn'; prev.textContent='‹ Prev'; prev.disabled = page <= 1; prev.addEventListener('click', ()=>{ if (reportTableState.page>1) { reportTableState.page--; runReport(); } });
          const next = document.createElement('button'); next.className='btn'; next.textContent='Next ›'; next.disabled = page >= totalPages; next.addEventListener('click', ()=>{ if (reportTableState.page < totalPages) { reportTableState.page++; runReport(); } });
          pager.appendChild(prev); pager.appendChild(next); leftTools.appendChild(pager);

          const rightTools = document.createElement('div'); rightTools.style.display='flex'; rightTools.style.alignItems='center'; rightTools.style.gap='8px';
          const dl = document.createElement('button'); dl.className='btn'; dl.textContent = 'Download Table CSV'; dl.addEventListener('click', downloadReportCSV);
          const dlzip = document.createElement('button'); dlzip.className='btn'; dlzip.textContent = 'Download ZIP (CSV + Chart)'; dlzip.addEventListener('click', downloadReportZip);
          rightTools.appendChild(dl); rightTools.appendChild(dlzip);
          tools.appendChild(leftTools); tools.appendChild(rightTools);

          const table = document.createElement('table'); table.className = 'table';
          const thead = document.createElement('thead'); thead.innerHTML = '<tr><th data-key="period" class="sortable">Period</th><th data-key="givenOut" class="sortable" style="text-align:right">Given Out</th><th data-key="remaining" class="sortable" style="text-align:right">Remaining</th><th data-key="count" class="sortable" style="text-align:right">Count</th><th style="text-align:right">Avg Given</th><th style="text-align:right">Avg Remaining</th></tr>';
          const tbody = document.createElement('tbody');

          // header sorting handlers
          Array.from(thead.querySelectorAll('th.sortable')).forEach(th=>{
            th.style.cursor = 'pointer'; th.title = 'Click to sort';
            th.addEventListener('click', ()=>{
              const key = th.dataset.key; if (reportTableState.sortKey === key) reportTableState.sortAsc = !reportTableState.sortAsc; else { reportTableState.sortKey = key; reportTableState.sortAsc = false; }
              reportTableState.page = 1; runReport();
            });
          });

          pageRows.forEach(d => {
            const tr = document.createElement('tr');
            const p = document.createElement('td'); p.className = 'chart-label-wrap'; p.textContent = d.period;
            const g = document.createElement('td'); g.style.textAlign = 'right'; g.textContent = d.givenOut.toLocaleString();
            const rem = document.createElement('td'); rem.style.textAlign = 'right'; rem.textContent = d.remaining.toLocaleString();
            const cnt = document.createElement('td'); cnt.style.textAlign = 'right'; cnt.textContent = d.count;
            const ag = document.createElement('td'); ag.style.textAlign = 'right'; ag.textContent = (d.avgGiven||0).toFixed(2);
            const ar = document.createElement('td'); ar.style.textAlign = 'right'; ar.textContent = (d.avgRemaining||0).toFixed(2);
            tr.appendChild(p); tr.appendChild(g); tr.appendChild(rem); tr.appendChild(cnt); tr.appendChild(ag); tr.appendChild(ar);
            tbody.appendChild(tr);
          });
          table.appendChild(thead); table.appendChild(tbody);
          wrap.innerHTML = ''; wrap.appendChild(tools); wrap.appendChild(table);
        }
      }
    } catch(e){ console.warn('Failed to render report table', e); }
  } catch(e){ showBanner('Error generating report: ' + (e.message||e), 'error'); }
}

// Download the last generated report as CSV
async function downloadReportCSV(){
  try{
    if (!lastReportData || !Array.isArray(lastReportData.data) || lastReportData.data.length === 0) return showBanner('No report data to download', 'warn');
    // Use human-friendly headers and include BOM for Excel compatibility
  const headers = ['Period','Given Out','Remaining','Earnings','Count'];
  const rows = lastReportData.data.map(r => [String(r.period || ''), Number(r.givenOut||0), Number(r.remaining||0), Number(r.earnings||0), Number(r.count||0)]);
    const escapeCell = (v) => {
      const s = String(v === null || v === undefined ? '' : v);
      return '"' + s.replace(/"/g,'""') + '"';
    };
    const csvLines = [headers.map(escapeCell).join(',')].concat(rows.map(cols => cols.map(escapeCell).join(',')));
    const csv = '\uFEFF' + csvLines.join('\n'); // prepend BOM
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const urlb = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = urlb;
    const tstamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    const fname = `report_${lastReportData.period}_${lastReportData.from||'all'}_${lastReportData.to||'all'}_${tstamp}.csv`;
    a.download = fname; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(urlb);
    showBanner('Report downloaded', 'info');
  } catch(e){ showBanner('Failed to download report: ' + (e.message||e), 'error'); }
}

// Download report as ZIP containing CSV and chart image (requires JSZip loaded on the page)
async function downloadReportZip(){
  try{
    if (!lastReportData || !Array.isArray(lastReportData.data) || lastReportData.data.length === 0) return showBanner('No report data to download', 'warn');
    // Build CSV text (same as downloadReportCSV)
  const headers = ['Period','Given Out','Remaining','Earnings','Count'];
  const rows = lastReportData.data.map(r => [String(r.period || ''), Number(r.givenOut||0), Number(r.remaining||0), Number(r.earnings||0), Number(r.count||0)]);
    const escapeCell = (v) => { const s = String(v === null || v === undefined ? '' : v); return '"' + s.replace(/"/g,'""') + '"'; };
    const csvLines = [headers.map(escapeCell).join(',')].concat(rows.map(cols => cols.map(escapeCell).join(',')));
    const csv = '\uFEFF' + csvLines.join('\n');
    const csvBlob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });

    // Grab chart image (if available)
    const canvas = document.getElementById('reportChart');
    let chartBlob = null;
    if (canvas && canvas.toDataURL){
      try{
        const dataUrl = canvas.toDataURL('image/png');
        const res = await fetch(dataUrl); chartBlob = await res.blob();
      } catch(e){ console.warn('Failed to capture chart image', e); }
    }

    if (typeof JSZip === 'undefined'){ showBanner('JSZip not available — cannot create ZIP', 'error'); return; }
    const zip = new JSZip();
    const tstamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    const csvName = `report_${lastReportData.period}_${lastReportData.from||'all'}_${lastReportData.to||'all'}_${tstamp}.csv`;
    zip.file(csvName, csvBlob);
    if (chartBlob) zip.file('chart.png', chartBlob);
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a'); a.href = url; a.download = `report_bundle_${tstamp}.zip`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    showBanner('ZIP downloaded', 'info');
  } catch(e){ showBanner('Failed to create ZIP: ' + (e.message||e), 'error'); }
}

async function exportCsvForActiveStation(){
  if (!activeStationId) return alert('No station selected');
  const from = $('recFrom') ? $('recFrom').value : '';
  const to = $('recTo') ? $('recTo').value : '';
  const params = [];
  if (from) params.push('from=' + encodeURIComponent(from));
  if (to) params.push('to=' + encodeURIComponent(to));
  const url = '/api/stations/' + encodeURIComponent(activeStationId) + '/records' + (params.length ? ('?' + params.join('&')) : '');
  try{
    const headers = getAuthHeaders();
    const res = await apiFetch(url, { headers }); if (!res.ok) throw new Error('Failed to fetch records');
  const j = await res.json(); const recs = (j.records || []).map(normalizeRecord);
  if (!recs.length) return alert('No records to export for selected range');
  const cols = ['date','startOfDay','givenOut','remaining','needRepair','damaged','earnings','notes'];
    const rows = recs.map(r => cols.map(c => '"' + String(r[c] || '').replace(/"/g,'""') + '"').join(','));
    const csv = cols.join(',') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const urlb = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = urlb;
    const name = (modalStationName && modalStationName.textContent ? modalStationName.textContent.replace(/\s+/g,'_') : activeStationId);
    const fname = `${name}_${from || 'all'}_${to || 'all'}.csv`;
    a.download = fname; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(urlb);
    showBanner('CSV exported', 'info');
  } catch(e){ showBanner('Failed to export CSV: ' + (e.message||e), 'error'); }
}

// ----- Sync guest stations (kept for compatibility) -----
async function syncGuestStationsToServer(){
  try{
    const token = localStorage.getItem(TOKEN_KEY); if (!token) return;
    const guestStations = stations.filter(s => s.guest === true); if (!guestStations.length) return;
    const payload = { stations: guestStations.map(s => ({ id: s.id, name: s.name, contact: s.contact, location: s.location, type: s.type, batteryCount: s.batteryCount, status: s.status, iotStatus: s.iotStatus, createdAt: s.createdAt })) };
    const res = await apiFetch('/api/stations/import', { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + token }, body: JSON.stringify(payload) });
    if (!res.ok) return;
    const j = await res.json();
    if (j.imported && Array.isArray(j.imported)){
      j.imported.forEach(item=>{
        const localId = item.localId; const serverStation = item.station; const idx = stations.findIndex(s=> s.id === localId);
        if (idx !== -1){ stations[idx].guest = false; stations[idx].serverId = serverStation.id; stations[idx].owner = serverStation.owner || stations[idx].owner; }
      });
      saveData(stations); showBanner(`Synced ${j.imported.length} local station(s) to your account`, 'info'); render();
    }
  } catch(e){ console.error('sync error', e); }
}

// ----- IoT Simulation -----
// Randomly change batteryCount and iotStatus on tick; record alerts
function simulateIoTTick(){
  // mutate a subset of stations randomly
  const count = Math.max(1, Math.round(stations.length * 0.25));
  for (let i = 0; i < count; i++){
    const idx = Math.floor(Math.random() * stations.length);
    const st = stations[idx];
    if (!st) continue;
    // small random battery consumption(+/-)
    const delta = Math.floor(Math.random() * 3) - 1; // -1,0,1
    st.batteryCount = Math.max(0, (Number(st.batteryCount)||0) + delta);
    // occasionally change iotStatus
    const r = Math.random();
    if (r < 0.06) st.iotStatus = 'Inactive';
    else if (r < 0.28) st.iotStatus = 'Charging';
    else if (r < 0.6) st.iotStatus = 'Active';
    else if (r < 0.8) st.iotStatus = 'Idle';
    else st.iotStatus = 'Under maintenance';
  }
  saveData(stations);
  render();
  // alert if any station low or offline
  detectAlerts();
}

function detectAlerts(){
  const low = stations.filter(s => Number(s.batteryCount) <= 2).length;
  const offline = stations.filter(s => s.iotStatus === 'Inactive').length;
  if (low > 0) showBanner(`${low} station(s) low on batteries`, 'warn');
  if (offline > 0) showBanner(`${offline} station(s) offline`, 'warn');
}

// start/stop simulation
function startIoTSimulation(){
  if (iotSimRunning) return;
  iotSimRunning = true;
  $('iotToggleBtn') && ($('iotToggleBtn').textContent = 'Stop Simulation');
  iotSimInterval = setInterval(simulateIoTTick, iotSimSpeedMs);
  showBanner('IoT simulation started', 'info');
}

function stopIoTSimulation(){
  if (!iotSimRunning) return;
  iotSimRunning = false;
  $('iotToggleBtn') && ($('iotToggleBtn').textContent = 'Start Simulation');
  clearInterval(iotSimInterval); iotSimInterval = null;
  showBanner('IoT simulation stopped', 'info');
}

// ----- Storage event sync across tabs -----
window.addEventListener('storage', (e)=>{
  if (e.key === BROADCAST_KEY && e.newValue){
    const parts = String(e.newValue).split(':'); const action = parts[0];
    if (action === 'logout'){ currentUser = null; clearAuth(); loginScreen.classList.remove('hidden'); appEl.classList.add('hidden'); lockUI(); }
    if (action === 'login'){ checkSession(); }
  }
  if (e.key === STORAGE_KEY && e.newValue){
    try{ stations = JSON.parse(e.newValue || '[]'); render(); } catch(e){}
  }
});

// ----- session probing -----
async function probePrimary(){
  try{
    const url = window.location.origin + '/api/session';
    const res = await fetch(url, { method:'GET' });
    if (!res.ok && (res.status === 404 || res.status === 405)){
      API_BASE = FALLBACK_API; setApiStatus(false, 'Primary origin does not host API — using fallback'); showBanner('Primary origin does not host API — using fallback API','warn'); return false;
    }
    // primary OK
    API_BASE = window.location.origin;
    setApiStatus(true, 'API available at ' + window.location.origin);
    return true;
  } catch(e){
    API_BASE = FALLBACK_API; setApiStatus(false, 'Primary origin unreachable — using fallback'); showBanner('Primary origin unreachable — using fallback API','warn'); return false;
  }
}

async function checkSession(){
  try{
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const res = await apiFetch('/api/session', { headers });
    if (!res.ok) return false;
    const j = await res.json();
    if (j.user){ currentUser = j.user; showUser(currentUser);
      // If we're on index page show continue session button
      if (window.location.pathname.endsWith('index.html') || window.location.pathname === '/'){
        const resumeBtn = $('resumeSessionBtn'); if (resumeBtn){ resumeBtn.style.display = 'inline-block'; resumeBtn.textContent = `Continue as ${currentUser}`; resumeBtn.onclick = ()=>{ window.location.href = 'app.html'; }; }
        lockUI(); return true;
      }
      unlockUI(); return true;
    }
    currentUser = null; lockUI(); return false;
  } catch(e){ currentUser = null; lockUI(); return false; }
}

// ----- UI lock/unlock -----
function lockUI(){ if (authGate) authGate.classList.remove('hidden'); if (appEl){ appEl.classList.add('locked'); appEl.style.display='none'; } document.body.classList.add('no-scroll'); }
function unlockUI(){ if (authGate) authGate.classList.add('hidden'); if (appEl){ appEl.classList.remove('locked'); appEl.style.display='flex'; } document.body.classList.remove('no-scroll'); }

// ----- Init -----
function init(){
  probePrimary().then(()=> checkSession().then(ok=>{
    if (ok){
      if (loginScreen) loginScreen.classList.add('hidden');
      if (appEl) appEl.classList.remove('hidden');
      // fetch stations from server and then show dashboard (falls back to local data if fetch fails)
      fetchStations().then(()=> setActiveNav('dashboard')).catch(()=> setActiveNav('dashboard'));
    }
    else { if (loginScreen) loginScreen.classList.remove('hidden'); if (appEl) appEl.classList.add('hidden'); lockUI(); }
    // ensure sim controls exist and wire them
    ensureSimControls();
    // initial chart & render
    updateChart(); render();
    // load maintenance panel and wire reports
    try{ renderMaintenancePanel();
      const runBtn = $('runReport'); if (runBtn) runBtn.addEventListener('click', runReport);
      // default report range: last 6 months
      const toEl = $('reportTo'), fromEl = $('reportFrom');
      if (toEl){ const now = new Date(); toEl.value = now.toISOString().slice(0,10); }
      if (fromEl){ const past = new Date(); past.setMonth(past.getMonth()-6); fromEl.value = past.toISOString().slice(0,10); }
      // run initial report
      setTimeout(()=> runReport(), 200);
    } catch(e){}
    // if stations is empty add demo data (only once)
    if (!stations || stations.length === 0){
      stations = [
        { id: uid(), name: 'Kimironko Hub', contact:'078800001', location:'Kimironko, Gasabo', type:'Service', batteryCount:12, status:'Active', iotStatus:'Active', createdAt:new Date().toISOString() },
        { id: uid(), name: 'Nyarugenge Exchange', contact:'078800002', location:'Nyarugenge', type:'Retail', batteryCount:8, status:'Active', iotStatus:'Charging', createdAt:new Date().toISOString() },
        { id: uid(), name: 'Musanze Depot', contact:'078800003', location:'Musanze', type:'Assembly', batteryCount:5, status:'Inactive', iotStatus:'Under maintenance', createdAt:new Date().toISOString() },
        { id: uid(), name: 'Kigali East', contact:'078800004', location:'Kicukiro', type:'Service', batteryCount:6, status:'Active', iotStatus:'Idle', createdAt:new Date().toISOString() }
      ];
      saveData(stations);
      render();
    }
    // wire backups UI (if present)
    try{
      const showBackupsBtn = $('showBackupsBtn'); if (showBackupsBtn) showBackupsBtn.addEventListener('click', showBackupsModal);
      const closeBackupsModalBtn = $('closeBackupsModal'); if (closeBackupsModalBtn) closeBackupsModalBtn.addEventListener('click', closeBackupsModal);
      const closeBackupsBtn = $('closeBackupsBtn'); if (closeBackupsBtn) closeBackupsBtn.addEventListener('click', closeBackupsModal);
      const refreshBackupsBtn = $('refreshBackupsBtn'); if (refreshBackupsBtn) refreshBackupsBtn.addEventListener('click', loadBackupsList);
    } catch(e){ console.warn('Backups UI not available', e); }
  }));
}

init();
 
