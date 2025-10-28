/* StationSync - app.js
   Prototype application: sidebar + login + localStorage data
   Adds client-side registration (PBKDF2), Remember-me (localStorage), and username badge.
   No backend — demo-only.
*/

const STORAGE_KEY = 'stationsync_v1';
const AUTH_KEY = 'stationsync_auth';
const USERS_KEY = 'stationsync_users';
const USER_KEY = 'stationsync_user';

// ---------- Utilities ----------
const $ = (id) => document.getElementById(id);
const uid = () => 'ST' + Date.now().toString(36).slice(-6).toUpperCase();

function loadData(){ try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch(e){ return []; } }
function saveData(d){ localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); }

function getUsers(){ try { return JSON.parse(localStorage.getItem(USERS_KEY) || '{}'); } catch(e){ return {}; } }
function saveUsers(u){ localStorage.setItem(USERS_KEY, JSON.stringify(u)); }

// ---------- Crypto helpers (PBKDF2 -> SHA-256 256-bit)
// Server-backed auth helpers
let currentUser = null;
const BROADCAST_KEY = 'stationsync_broadcast';
const TOKEN_KEY = 'stationsync_token';

function isAuthenticated(){
  return currentUser !== null;
}

// Base URL for backend API — default to the current origin so the frontend
// will call the same host/port that served the page (works when your
// backend and frontend are on the same origin, e.g., port 5500).
let API_BASE = window.location.origin;
const FALLBACK_API = 'http://localhost:3000';

// apiFetch: try primary origin first, fall back to FALLBACK_API only on
// network-level failures (e.g. connection refused / failed to fetch).
async function apiFetch(path, options){
  const primaryUrl = API_BASE + path;
  try{
    const res = await fetch(primaryUrl, options);
    // If primary responds with 404/405 it often means there's no API on that origin
    // (for example Live Server serving static files). In that case try fallback.
    if (res && (res.status === 404 || res.status === 405)){
      console.warn('Primary API returned', res.status, '– trying fallback');
      try{ showBanner('Primary API returned ' + res.status + ', trying fallback', 'warn'); } catch(e){}
      const fallbackUrl = FALLBACK_API + path;
      return await fetch(fallbackUrl, options);
    }
    return res;
  } catch(primaryErr){
    console.warn('Primary API fetch failed, trying fallback URL:', primaryErr);
    try{ showBanner('Primary API unreachable, using fallback API', 'warn'); } catch(e){}
    const fallbackUrl = FALLBACK_API + path;
    return await fetch(fallbackUrl, options);
  }
}

// small on-screen banner for notices
function showBanner(message, type='info'){
  try{
    let b = document.getElementById('ss-banner');
    if (!b){
      b = document.createElement('div');
      b.id = 'ss-banner';
      b.style.position = 'fixed';
      b.style.top = '12px';
      b.style.right = '12px';
      b.style.zIndex = 9999;
      b.style.padding = '8px 12px';
      b.style.borderRadius = '6px';
      b.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
      b.style.fontFamily = 'system-ui, Arial, sans-serif';
      document.body.appendChild(b);
    }
    b.textContent = message;
    b.style.background = type === 'error' ? '#fee2e2' : (type === 'warn' ? '#fef3c7' : '#ecfeff');
    b.style.color = '#111827';
    setTimeout(() => { try{ b.remove(); }catch(e){} }, 4000);
  } catch(e){}
}

async function checkSession(){
  try{
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
  const res = await apiFetch('/api/session', { headers });
    if (!res.ok) return false;
    const j = await res.json();
    if (j.user){
      currentUser = j.user; showUser(currentUser);
      // if we are on the login page, navigate to the app page
      if (window.location.pathname.endsWith('index.html') || window.location.pathname === '/' ){
        window.location.href = 'app.html';
        return true;
      }
      // otherwise unlock UI if app is present
      unlockUI();
      return true;
    }
    currentUser = null;
    // if we're on the app page but not authenticated, send user back to login
    if (window.location.pathname.endsWith('app.html')){
      window.location.href = 'index.html';
      return false;
    }
    lockUI();
    return false;
  } catch(e){ currentUser = null; lockUI(); return false; }
}

// probePrimary: check whether the primary origin actually exposes the API.
// If primary responds with 404/405 or the request fails, switch to fallback permanently.
async function probePrimary(){
  try{
    const url = window.location.origin + '/api/session';
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok && (res.status === 404 || res.status === 405)){
      API_BASE = FALLBACK_API;
      showBanner('Primary origin does not host API — using fallback API', 'warn');
      return false;
    }
    return true;
  } catch(e){
    API_BASE = FALLBACK_API;
    showBanner('Primary origin unreachable — using fallback API', 'warn');
    return false;
  }
}

async function serverLogin(username, password, remember){
  try{
    const res = await apiFetch('/api/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password, remember })
    });
    if (!res.ok){
      let body = await res.text().catch(()=>null);
      try{ body = JSON.parse(body); } catch(e){}
      const msg = (body && body.message) ? body.message : (`Login failed (status ${res.status})`);
      showBanner(msg, 'error');
      throw new Error(msg);
    }
    const j = await res.json();
    if (j.token) try { localStorage.setItem(TOKEN_KEY, j.token); } catch(e){}
    currentUser = j.user; showUser(currentUser);
    try { localStorage.setItem(BROADCAST_KEY, 'login:' + Date.now()); } catch(e){}
    return true;
  } catch(err){
    // network or other error
    showBanner('Login request failed: ' + (err.message || err), 'error');
    throw err;
  }
}

async function serverRegister(username, password, remember){
  try{
    const res = await apiFetch('/api/register', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username, password, remember })
    });
    if (!res.ok){
      let body = await res.text().catch(()=>null);
      try{ body = JSON.parse(body); } catch(e){}
      const msg = (body && body.message) ? body.message : (`Register failed (status ${res.status})`);
      showBanner(msg, 'error');
      throw new Error(msg);
    }
    const j = await res.json();
    if (j.token) try { localStorage.setItem(TOKEN_KEY, j.token); } catch(e){}
    currentUser = j.user; showUser(currentUser);
    try { localStorage.setItem(BROADCAST_KEY, 'login:' + Date.now()); } catch(e){}
    return true;
  } catch(err){
    showBanner('Registration request failed: ' + (err.message || err), 'error');
    throw err;
  }
}

async function serverLogout(){
  try{ await apiFetch('/api/logout',{ method:'POST' }); } catch(e){}
  try{ localStorage.removeItem(TOKEN_KEY); } catch(e){}
  currentUser = null; clearAuth();
  try { localStorage.setItem(BROADCAST_KEY, 'logout:' + Date.now()); } catch(e){}
}

// ---------- App state ----------
let stations = loadData();
let currentPage = 'dashboard';
let iotChart = null;

// ---------- Elements ----------
const loginScreen = document.getElementById('loginScreen');
const loginForm = document.getElementById('loginForm');
const registerCard = document.getElementById('registerCard');
const registerForm = document.getElementById('registerForm');
const showRegisterBtn = document.getElementById('showRegister');
const showLoginBtn = document.getElementById('showLogin');
const rememberEl = document.getElementById('rememberMe');
const authGate = document.getElementById('authGate');
const authGateLogin = document.getElementById('authGateLogin');
const appEl = document.getElementById('app');
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');
const pageTitle = document.getElementById('pageTitle');
const pageSubtitle = document.getElementById('pageSubtitle');
const globalSearch = document.getElementById('globalSearch');
const userBadge = document.getElementById('userBadge');

// dashboard elements
const stationsTableBody = document.querySelector('#stationsTable tbody');
const totalStationsEl = document.getElementById('totalStations');
const activeStationsEl = document.getElementById('activeStations');
const inactiveStationsEl = document.getElementById('inactiveStations');
const totalBatteriesEl = document.getElementById('totalBatteries');

// register form for stations
const stationForm = document.getElementById('stationForm');
const resetFormBtn = document.getElementById('resetForm');

// analytics
const locationList = document.getElementById('locationList');

// ---------- Initial demo data if empty ----------
if (stations.length === 0){
  stations = [
    { id: uid(), name: 'Kimironko Hub', contact:'078800001', location:'Kimironko, Gasabo', type:'Service', batteryCount:12, status:'Active', iotStatus:'Active', createdAt:new Date().toISOString() },
    { id: uid(), name: 'Nyarugenge Exchange', contact:'078800002', location:'Nyarugenge', type:'Retail', batteryCount:8, status:'Active', iotStatus:'Charging', createdAt:new Date().toISOString() },
    { id: uid(), name: 'Musanze Depot', contact:'078800003', location:'Musanze', type:'Assembly', batteryCount:5, status:'Inactive', iotStatus:'Under maintenance', createdAt:new Date().toISOString() },
    { id: uid(), name: 'Kigali East', contact:'078800004', location:'Kicukiro', type:'Service', batteryCount:6, status:'Active', iotStatus:'Idle', createdAt:new Date().toISOString() }
  ];
  saveData(stations);
}

// ---------- Auth helpers (server-backed)
function isAuthenticated(){
  return currentUser !== null;
}

function getCurrentUser(){
  return currentUser;
}

// clearAuth remains to clear any client-side state and lock UI
function clearAuth(){
  try{ sessionStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(USER_KEY); } catch(e){}
  try{ localStorage.removeItem(AUTH_KEY); localStorage.removeItem(USER_KEY); } catch(e){}
  hideUser();
  currentUser = null;
  lockUI();
}

function showUser(name){
  if (!userBadge) return;
  userBadge.textContent = `Signed in: ${name}`;
  userBadge.classList.remove('hidden');
}

function hideUser(){ if (!userBadge) return; userBadge.textContent = ''; userBadge.classList.add('hidden'); }

function lockUI(){
  if (authGate) authGate.classList.remove('hidden');
  if (appEl) {
    appEl.classList.add('locked');
    // hide app to prevent any visibility while auth gate is up
    appEl.style.display = 'none';
  }
  try { document.body.classList.add('no-scroll'); } catch(e){}
}

function unlockUI(){
  if (authGate) authGate.classList.add('hidden');
  if (appEl) {
    appEl.classList.remove('locked');
    // restore display
    appEl.style.display = 'flex';
  }
  try { document.body.classList.remove('no-scroll'); } catch(e){}
}

// sync logout across tabs when localStorage changes
window.addEventListener('storage', (e) => {
  // Listen for broadcasts from other tabs
  if (e.key === BROADCAST_KEY && e.newValue){
    try{
      const parts = String(e.newValue).split(':');
      const action = parts[0];
      if (action === 'logout'){
        // another tab logged out
        currentUser = null;
        clearAuth();
        loginScreen.classList.remove('hidden');
        appEl.classList.add('hidden');
        lockUI();
      } else if (action === 'login'){
        // another tab logged in — re-check session
        checkSession();
      }
    } catch(e){}
  }
  // backward-compat: if AUTH_KEY cleared in localStorage
  if (e.key === AUTH_KEY && e.newValue == null){
    currentUser = null; clearAuth(); loginScreen.classList.remove('hidden'); appEl.classList.add('hidden'); lockUI();
  }
});

// ---------- Navigation & Page logic ----------
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
}

navItems.forEach(btn => btn.addEventListener('click', () => setActiveNav(btn.dataset.page)));

// global search
globalSearch.addEventListener('input', render);

// logout
$('logoutBtn').addEventListener('click', async () => {
  try{
    await serverLogout();
  } catch(e){
    // fallback to client-side clear
    clearAuth();
  }
  appEl.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  lockUI();
});

// ---------- Login / Register UI toggles ----------
showRegisterBtn && showRegisterBtn.addEventListener('click', () => {
  loginForm.parentElement.classList.add('hidden');
  registerCard.classList.remove('hidden');
});
showLoginBtn && showLoginBtn.addEventListener('click', () => {
  registerCard.classList.add('hidden');
  loginForm.parentElement.classList.remove('hidden');
});

authGateLogin && authGateLogin.addEventListener('click', () => {
  // bring user to the login form
  registerCard && registerCard.classList.add('hidden');
  if (loginForm && loginForm.parentElement) loginForm.parentElement.classList.remove('hidden');
  loginScreen.classList.remove('hidden');
  authGate && authGate.classList.add('hidden');
});

// ---------- Login ----------
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = $('loginUser').value.trim();
  const p = $('loginPass').value.trim();
  const remember = rememberEl && rememberEl.checked;
  if (!u || !p) return alert('Enter username and password.');

  try{
    await serverLogin(u, p, remember);
    // serverLogin sets currentUser & shows badge
    unlockUI();
    loginScreen.classList.add('hidden');
    appEl.classList.remove('hidden');
    setActiveNav('dashboard');
  } catch(err){ alert(err.message || 'Login failed'); }
});

// Fallback: if normal login fails, allow auto-login in dev for any registered user
// (calls /api/auto-login). This only works if the username exists on the server.
async function tryAutoLogin(username){
  try{
    // first fetch list of users to confirm existence
  const listRes = await apiFetch('/api/users');
    if (!listRes.ok) return false;
    const lj = await listRes.json();
    if (!lj.users || !Array.isArray(lj.users)) return false;
    if (lj.users.indexOf(username) === -1) return false;

    // attempt auto-login
    const res = await apiFetch('/api/auto-login', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username })
    });
    if (!res.ok) return false;
    const j = await res.json();
    if (j.user){
      if (j.token) try { localStorage.setItem(TOKEN_KEY, j.token); } catch(e){}
      currentUser = j.user; showUser(currentUser); return true;
    }
    return false;
  } catch(e){ return false; }
}

// Replace the login submit handler with one that falls back to auto-login
if (loginForm){
  loginForm.removeEventListener && loginForm.removeEventListener('submit', ()=>{});
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = $('loginUser').value.trim();
    const p = $('loginPass').value.trim();
    const remember = rememberEl && rememberEl.checked;
    if (!u) return alert('Enter username.');

    try{
        await serverLogin(u, p, remember);
        // navigate to the separate app page after successful login
        window.location.href = 'app.html';
      return;
    } catch(err){
      // try auto-login for registered users
      const ok = await tryAutoLogin(u);
      if (ok){
          window.location.href = 'app.html';
        return;
      }
      alert(err.message || 'Login failed');
    }
  });
}

// ---------- Register ----------
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = $('regUser').value.trim();
  const p1 = $('regPass').value;
  const p2 = $('regPass2').value;
  if (!u || !p1) return alert('Choose a username and password.');
  if (p1 !== p2) return alert('Passwords do not match.');

  try{
    await serverRegister(u, p1, true);
    // serverRegister sets currentUser & shows badge
    registerCard.classList.add('hidden');
    loginForm.parentElement.classList.remove('hidden');
    loginScreen.classList.add('hidden');
    appEl.classList.remove('hidden');
    unlockUI();
    setActiveNav('dashboard');
  } catch(err){ alert(err.message || 'Registration failed'); }
});

// ---------- Rendering ----------
function render(){
  if (!isAuthenticated()) return;
  // apply search filter
  const q = globalSearch.value.trim().toLowerCase();
  let filtered = stations.filter(s => {
    if (!q) return true;
    return (s.name + ' ' + s.location + ' ' + s.id).toLowerCase().includes(q);
  });

  // dashboard stats
  totalStationsEl.textContent = stations.length;
  activeStationsEl.textContent = stations.filter(s => s.status === 'Active').length;
  inactiveStationsEl.textContent = stations.filter(s => s.status === 'Inactive').length;
  totalBatteriesEl.textContent = stations.reduce((sum, s) => sum + (Number(s.batteryCount)||0), 0);

  // table
  stationsTableBody.innerHTML = '';
  filtered.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.id}</td>
      <td>${escape(s.name)}</td>
      <td>${escape(s.location)}</td>
      <td>${escape(s.type)}</td>
      <td>${s.batteryCount}</td>
      <td>${escape(s.status)}</td>
      <td>${escape(s.iotStatus)}</td>
      <td>
        <button class="btn danger" data-action="delete" data-id="${s.id}"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    stationsTableBody.appendChild(tr);
  });

  // analytics chart update
  updateChart();

  // location list
  renderLocations();
}

// escape helper
function escape(str=''){ return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ---------- Form: add station ----------
stationForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!isAuthenticated()) { alert('Please login first.'); return; }
  const name = $('stationName').value.trim();
  const contact = $('stationContact').value.trim();
  const location = $('stationLocation').value.trim();
  const type = $('stationType').value;
  const batteryCount = Number($('batteryCount').value) || 0;
  const status = $('stationStatus').value;
  const iotStatus = $('iotStatus').value;

  const newStation = { id: uid(), name, contact, location, type, batteryCount, status, iotStatus, createdAt: new Date().toISOString() };
  stations.unshift(newStation);
  saveData(stations);
  stationForm.reset();
  setActiveNav('dashboard');
});

resetFormBtn.addEventListener('click', () => stationForm.reset());

// ---------- Table actions (delegation) ----------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (!action) return;

  if (!isAuthenticated()) { alert('Please login first.'); return; }

  if (action === 'delete') {
    if (!confirm('Delete station?')) return;
    stations = stations.filter(s => s.id !== id);
    saveData(stations);
    render();
  }
});

// ---------- Analytics: Chart ----------
function updateChart(){
  const statuses = ['Charging','Idle','Active','Under maintenance','Inactive'];
  const counts = statuses.map(st => stations.filter(s => s.iotStatus === st).length);

  const ctx = document.getElementById('iotChart').getContext('2d');
  if (iotChart) {
    iotChart.data.labels = statuses;
    iotChart.data.datasets[0].data = counts;
    iotChart.update();
    return;
  }

  iotChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: statuses,
      datasets: [{
        data: counts,
        backgroundColor: ['#06b6b4','#60a5fa','#0ea5a6','#f59e0b','#ef4444']
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position:'bottom' }
      }
    }
  });
}

// ---------- Location distribution (simple) ----------
function renderLocations(){
  const byLocation = {};
  stations.forEach(s => {
    const loc = s.location || 'Unknown';
    byLocation[loc] = (byLocation[loc] || 0) + 1;
  });

  locationList.innerHTML = '';
  Object.keys(byLocation).forEach(loc => {
    const div = document.createElement('div');
    div.className = 'location-item';
    div.innerHTML = `<strong>${escape(loc)}</strong> — ${byLocation[loc]} station(s)`;
    locationList.appendChild(div);
  });
}

// ---------- Init ----------
function init(){
  // probe primary origin for API then check server session on init
  probePrimary().then(()=>{
    checkSession().then(ok => {
    if (ok){
      loginScreen.classList.add('hidden');
      appEl.classList.remove('hidden');
      setActiveNav('dashboard');
    } else {
      loginScreen.classList.remove('hidden');
      appEl.classList.add('hidden');
      lockUI();
    }
    });
  });

  // expose a shorthand for document.getElementById
  window.$ = (id) => document.getElementById(id);

  // wire small UI toggles
  if (registerCard) registerCard.classList.add('hidden');
}
init();

// ---------- User account helpers (register/verify) ----------

