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
      alert(err.message || 'Login failed');
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
  totalStationsEl.textContent = stations.length;
  activeStationsEl.textContent = stations.filter(s => s.status === 'Active').length;
  inactiveStationsEl.textContent = stations.filter(s => s.status === 'Inactive').length;
  totalBatteriesEl.textContent = stations.reduce((acc,s)=> acc + (Number(s.batteryCount)||0), 0);

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
      <td>${escapeHtml(s.status)}</td>
      <td>${escapeHtml(s.iotStatus)} ${offline ? '<span class="alert-icon" title="Offline">⚠</span>' : ''}</td>
      <td>
        <button class="btn" data-action="view" data-id="${s.id}" title="View station"><i class="fa-solid fa-eye"></i></button>
        <button class="btn danger" data-action="delete" data-id="${s.id}" title="Delete station"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    stationsTableBody.appendChild(tr);
  });

  updateChart();
  renderLocations();
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

// ----- Station form submit -----
if (stationForm) stationForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const name = $('stationName').value.trim(); if (!name) { alert('Station name is required'); return; }
  const contact = $('stationContact').value.trim(); const location = $('stationLocation').value.trim();
  const type = $('stationType').value; const batteryCount = Number($('batteryCount').value) || 0;
  const status = $('stationStatus').value; const iotStatus = $('iotStatus').value;
  const payload = { name, contact, location, type, batteryCount, status, iotStatus };

  try{
    const previewHtml = `<div><strong>Name:</strong> ${escapeHtml(name)}</div><div><strong>Location:</strong> ${escapeHtml(location)}</div><div><strong>Initial batteries:</strong> ${batteryCount}</div><div><strong>Status:</strong> ${escapeHtml(status)}</div><div><strong>IoT:</strong> ${escapeHtml(iotStatus)}</div>`;
    const ok = await openConfirmModal('Preview station before saving', previewHtml); if (!ok) return;
  } catch(e){}

  if (isAuthenticated()){
    try{
      const token = localStorage.getItem(TOKEN_KEY);
      const headers = { 'Content-Type':'application/json' }; if (token) headers['Authorization'] = 'Bearer ' + token;
      const res = await apiFetch('/api/stations', { method:'POST', headers, body: JSON.stringify(payload) });
      if (!res.ok){ const body = await res.json().catch(()=>({message:'Failed'})); showBanner('Failed to register station: ' + (body.message||res.status), 'error'); return; }
      const j = await res.json();
      // fetch authoritative list
      try{ const listRes = await apiFetch('/api/stations'); if (listRes.ok){ const lj = await listRes.json(); if (lj.stations) { stations = lj.stations.slice(); saveData(stations); } } } catch(e){}
      render();
      showBanner('Station registered', 'info', { actionText: 'View', onClick: ()=>{ if (j.station && j.station.id) { openStationModal(j.station.id); setActiveNav('dashboard'); highlightStationRow(j.station.id); } } });
      stationForm.reset(); setActiveNav('dashboard');
      setTimeout(()=>{ if (j.station && j.station.id) highlightStationRow(j.station.id); }, 120);
    } catch(err){ showBanner('Error saving station: ' + (err.message||err), 'error'); }
    return;
  }
  alert('Please sign in before registering a station.');
});

resetFormBtn && resetFormBtn.addEventListener('click', ()=> stationForm.reset());

// table delegation
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('button'); if (!btn) return;
  const action = btn.dataset.action; const id = btn.dataset.id; if (!action) return;
  if (!isAuthenticated()){ alert('Please login first.'); return; }
  if (action === 'delete'){
    if (!confirm('Delete station?')) return;
    stations = stations.filter(s=> s.id !== id); saveData(stations); render();
  }
  if (action === 'view'){ openStationModal(id); }
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

function formatDate(iso){ try{ return new Date(iso).toLocaleString(); } catch(e){ return iso; } }

function openStationModal(id){
  activeStationId = id;
  const st = stations.find(s=>s.id===id);
  if (!st) return alert('Station not found');
  modalStationName.textContent = st.name;
  modalStationInfo.innerHTML = `<strong>Location:</strong> ${escapeHtml(st.location)} — <strong>Contact:</strong> ${escapeHtml(st.contact)}<br/><strong>Type:</strong> ${escapeHtml(st.type)} — <strong>Batteries:</strong> ${st.batteryCount}`;
  modalRecordsList.innerHTML = '<em>Loading records...</em>';
  stationModal.classList.remove('hidden');
  try{ $('recDate').value = new Date().toISOString().slice(0,10); }catch(e){}
  loadStationRecords(id);
}
function closeStationModal(){ stationModal.classList.add('hidden'); activeStationId = null; modalRecordsList.innerHTML=''; editingRecordId=null; recordForm && recordForm.reset(); }

closeStationModalBtn && closeStationModalBtn.addEventListener('click', closeStationModal);

async function loadStationRecords(stationId){
  try{
    const res = await apiFetch(`/api/stations/${stationId}/records`);
    if (!res.ok){ modalRecordsList.innerHTML = '<div class="muted">No records</div>'; return; }
    const j = await res.json(); const recs = j.records || []; lastLoadedRecords = recs.slice();
    if (recs.length === 0) { modalRecordsList.innerHTML = '<div class="muted">No records</div>'; return; }
    modalRecordsList.innerHTML = '';
    recs.forEach(r=>{
      const div = document.createElement('div'); div.className='record-item';
      const info = document.createElement('div'); info.className='record-info';
      info.innerHTML = `<strong>${escapeHtml(r.date)}</strong> — Start: ${r.startOfDay}, Given: ${r.givenOut}, Remaining: ${r.remaining}, Repair: ${r.needRepair}, Damaged: ${r.damaged}`;
      const notes = document.createElement('div'); notes.className='muted'; notes.textContent = r.notes || '';
      const meta = document.createElement('div'); meta.className='muted'; meta.textContent = formatDate(r.createdAt) + (r.updatedAt ? (' • Updated: ' + formatDate(r.updatedAt)) : '');
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
    remaining: Number($('recRemaining').value)||0, needRepair: Number($('recRepair').value)||0, damaged: Number($('recDamaged').value)||0, notes: $('recNotes').value||''
  };
  try{
    if (editingRecordId){
      const res = await apiFetch(`/api/stations/${activeStationId}/records/${editingRecordId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('Update failed');
      showBanner('Record updated', 'info');
      editingRecordId=null; recordForm.reset(); await loadStationRecords(activeStationId); return;
    }
    // duplicate date check
    const dup = lastLoadedRecords.find(r => r.date === payload.date);
    if (dup){
      if (!confirm('A record for this date already exists. Overwrite it?')) return;
      const res = await apiFetch(`/api/stations/${activeStationId}/records/${dup.id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('Update failed');
      showBanner('Record updated', 'info'); recordForm.reset(); await loadStationRecords(activeStationId); return;
    }
    const res = await apiFetch(`/api/stations/${activeStationId}/records`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('Save failed');
    await loadStationRecords(activeStationId); showBanner('Record saved', 'info'); recordForm.reset();
  } catch(err){ showBanner('Failed to save record: ' + (err.message||err), 'error'); }
});

function startEditRecord(record){
  editingRecordId = record.id;
  $('recDate').value = record.date; $('recStart').value = record.startOfDay||0; $('recGiven').value = record.givenOut||0;
  $('recRemaining').value = record.remaining||0; $('recRepair').value = record.needRepair||0; $('recDamaged').value = record.damaged||0; $('recNotes').value = record.notes||'';
  const submitBtn = recordForm.querySelector('button[type="submit"]'); if (submitBtn) submitBtn.textContent = 'Update Record';
  showBanner('Editing record — make changes and Save', 'info');
}

async function deleteRecord(rid){
  if (!confirm('Delete this record?')) return;
  try{
    const res = await apiFetch(`/api/stations/${activeStationId}/records/${rid}`, { method:'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    showBanner('Record deleted', 'info'); await loadStationRecords(activeStationId);
  } catch(e){ showBanner('Failed to delete record: ' + (e.message||e), 'error'); }
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
    if (!res.ok && (res.status === 404 || res.status === 405)){ API_BASE = FALLBACK_API; showBanner('Primary origin does not host API — using fallback API','warn'); return false; }
    return true;
  } catch(e){ API_BASE = FALLBACK_API; showBanner('Primary origin unreachable — using fallback API','warn'); return false; }
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
    if (ok){ if (loginScreen) loginScreen.classList.add('hidden'); if (appEl) appEl.classList.remove('hidden'); setActiveNav('dashboard'); }
    else { if (loginScreen) loginScreen.classList.remove('hidden'); if (appEl) appEl.classList.add('hidden'); lockUI(); }
    // ensure sim controls exist and wire them
    ensureSimControls();
    // initial chart & render
    updateChart(); render();
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
  }));
}

init();
