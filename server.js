const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');
const STATIONS_FILE = path.join(__dirname, 'stations.json');
const RECORDS_FILE = path.join(__dirname, 'records.json');

function loadUsers(){
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '{}'); } catch(e){ return {}; }
}

function saveUsers(u){
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); } catch(e){ console.error('Failed to save users', e); }
}

function loadStations(){
  try { return JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8') || '[]'); } catch(e){ return []; }
}

function saveStations(s){
  try { fs.writeFileSync(STATIONS_FILE, JSON.stringify(s, null, 2)); } catch(e){ console.error('Failed to save stations', e); }
}

function loadRecords(){
  try { return JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8') || '[]'); } catch(e){ return []; }
}

function saveRecords(r){
  try { fs.writeFileSync(RECORDS_FILE, JSON.stringify(r, null, 2)); } catch(e){ console.error('Failed to save records', e); }
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_in_prod';

// Allow the frontend running on Live Server (port 5500) to call the API.
// Adjust the allowed origins as needed. We accept both localhost and 127.0.0.1 on port 5500.
const FRONTEND_ORIGINS = [
  'http://127.0.0.1:5500',
  'http://localhost:5500'
];

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// For local development accept any origin so Live Server (or other dev servers) can reach us.
// If you want stricter control, replace `origin: true` with a function checking FRONTEND_ORIGINS.
app.use(cors({ origin: true, credentials: true }));

// Simple request logger to aid debugging — prints method, url and Origin header.
app.use((req, res, next) => {
  try{
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} Origin:${req.headers.origin || '-'} Host:${req.headers.host}`);
  } catch(e){}
  next();
});

app.use(session({
  name: 'stationsync_sid',
  secret: 'change_this_secret_in_prod',
  resave: false,
  saveUninitialized: false,
  // For local development we keep secure=false. If you serve over HTTPS set secure=true.
  cookie: { httpOnly: true, secure: false, sameSite: 'lax' }
}));

// Register
app.post('/api/register', async (req, res) => {
  const { username, password, remember } = req.body || {};
  if (!username || !password) return res.status(400).json({ message: 'Missing username or password' });
  const users = loadUsers();
  if (users[username]) return res.status(409).json({ message: 'Username already exists' });
  try{
    const hash = await bcrypt.hash(password, 12);
    users[username] = { hash };
    saveUsers(users);
    // create a JWT token for client-side use
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: remember ? '30d' : '2h' });
    // still set session for compatibility (dev)
    req.session.user = username;
    if (remember) req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
    return res.json({ user: username, token });
  } catch(e){ console.error(e); return res.status(500).json({ message: 'Server error' }); }
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password, remember } = req.body || {};
  if (!username || !password) return res.status(400).json({ message: 'Missing username or password' });
  const users = loadUsers();
  const rec = users[username];
  if (!rec) {
    console.log(`Login attempt for unknown user: ${username}`);
    return res.status(404).json({ message: 'User not found' });
  }
  try{
    console.log(`Login attempt for user: ${username} — verifying password`);
    const ok = await bcrypt.compare(password, rec.hash);
    console.log(`Password match for ${username}: ${ok}`);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    // create JWT token
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: remember ? '30d' : '2h' });
    req.session.user = username;
    if (remember) req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
    return res.json({ user: username, token });
  } catch(e){ console.error(e); return res.status(500).json({ message: 'Server error' }); }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ message: 'Logout failed' });
    res.clearCookie('stationsync_sid');
    return res.json({ ok: true });
  });
});

// Session
app.get('/api/session', (req, res) => {
  // Try token from Authorization header first
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')){
    const token = auth.slice(7).trim();
    try{
      const payload = jwt.verify(token, JWT_SECRET);
      return res.json({ user: payload.user });
    } catch(e){ /* fall back to session below */ }
  }
  if (req.session && req.session.user) return res.json({ user: req.session.user });
  return res.json({ user: null });
});

// Development helper: list registered usernames (no hashes)
// This is intentionally simple and should not be exposed in production.
app.get('/api/users', (req, res) => {
  try{
    const users = loadUsers();
    return res.json({ users: Object.keys(users) });
  } catch(e){ return res.status(500).json({ message: 'Server error' }); }
});

// Stations API
app.get('/api/stations', (req, res) => {
  try{
    const stations = loadStations();
    return res.json({ stations });
  } catch(e){ console.error(e); return res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/stations', (req, res) => {
  try{
    const { name, contact, location, type, batteryCount, status, iotStatus } = req.body || {};
    if (!name) return res.status(400).json({ message: 'Missing station name' });
    const stations = loadStations();
    const id = 'ST' + Date.now().toString(36).slice(-6).toUpperCase();
    const newStation = { id, name, contact, location, type, batteryCount: Number(batteryCount)||0, status: status||'Active', iotStatus: iotStatus||'Idle', createdAt: new Date().toISOString() };
    stations.unshift(newStation);
    saveStations(stations);
    return res.json({ station: newStation });
  } catch(e){ console.error(e); return res.status(500).json({ message: 'Server error' }); }
});

app.put('/api/stations/:id', (req, res) => {
  try{
    const id = req.params.id;
    const stations = loadStations();
    const idx = stations.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Station not found' });
    const upd = Object.assign({}, stations[idx], req.body);
    stations[idx] = upd;
    saveStations(stations);
    return res.json({ station: upd });
  } catch(e){ console.error(e); return res.status(500).json({ message: 'Server error' }); }
});

app.delete('/api/stations/:id', (req, res) => {
  try{
    const id = req.params.id;
    let stations = loadStations();
    stations = stations.filter(s => s.id !== id);
    saveStations(stations);
    // also remove records
    let records = loadRecords();
    records = records.filter(r => r.stationId !== id);
    saveRecords(records);
    return res.json({ ok: true });
  } catch(e){ console.error(e); return res.status(500).json({ message: 'Server error' }); }
});

// Records API
app.get('/api/stations/:id/records', (req, res) => {
  try{
    const stationId = req.params.id;
    const records = loadRecords().filter(r => r.stationId === stationId).sort((a,b)=> b.createdAt.localeCompare(a.createdAt));
    return res.json({ records });
  } catch(e){ console.error(e); return res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/stations/:id/records', (req, res) => {
  try{
    const stationId = req.params.id;
    const { date, startOfDay, givenOut, remaining, needRepair, damaged, notes } = req.body || {};
    if (!date) return res.status(400).json({ message: 'Missing date' });
    // Upsert behavior: if a record for this station+date exists, update it.
    const records = loadRecords();
    const existingIdx = records.findIndex(r => r.stationId === stationId && r.date === date);
    if (existingIdx !== -1){
      // update existing record
      const upd = Object.assign({}, records[existingIdx], {
        startOfDay: Number(startOfDay)||0,
        givenOut: Number(givenOut)||0,
        remaining: Number(remaining)||0,
        needRepair: Number(needRepair)||0,
        damaged: Number(damaged)||0,
        notes: notes||'',
        updatedAt: new Date().toISOString()
      });
      records[existingIdx] = upd;
      saveRecords(records);
      return res.json({ record: upd, updated: true });
    }

    const rid = 'R' + Date.now().toString(36).slice(-8).toUpperCase();
    const rec = { id: rid, stationId, date, startOfDay: Number(startOfDay)||0, givenOut: Number(givenOut)||0, remaining: Number(remaining)||0, needRepair: Number(needRepair)||0, damaged: Number(damaged)||0, notes: notes||'', createdAt: new Date().toISOString() };
    records.unshift(rec);
    saveRecords(records);
    return res.json({ record: rec, created: true });
  } catch(e){ console.error(e); return res.status(500).json({ message: 'Server error' }); }
});

// Edit a specific record by id
app.put('/api/stations/:id/records/:rid', (req, res) => {
  try{
    const stationId = req.params.id;
    const rid = req.params.rid;
    const { date, startOfDay, givenOut, remaining, needRepair, damaged, notes } = req.body || {};
    const records = loadRecords();
    const idx = records.findIndex(r => r.id === rid && r.stationId === stationId);
    if (idx === -1) return res.status(404).json({ message: 'Record not found' });
    const updated = Object.assign({}, records[idx], {
      date: date || records[idx].date,
      startOfDay: Number(startOfDay)||Number(records[idx].startOfDay)||0,
      givenOut: Number(givenOut)||Number(records[idx].givenOut)||0,
      remaining: Number(remaining)||Number(records[idx].remaining)||0,
      needRepair: Number(needRepair)||Number(records[idx].needRepair)||0,
      damaged: Number(damaged)||Number(records[idx].damaged)||0,
      notes: typeof notes === 'undefined' ? records[idx].notes : notes,
      updatedAt: new Date().toISOString()
    });
    records[idx] = updated;
    saveRecords(records);
    return res.json({ record: updated });
  } catch(e){ console.error(e); return res.status(500).json({ message: 'Server error' }); }
});

// Delete a specific record by id
app.delete('/api/stations/:id/records/:rid', (req, res) => {
  try{
    const stationId = req.params.id;
    const rid = req.params.rid;
    let records = loadRecords();
    const before = records.length;
    records = records.filter(r => !(r.id === rid && r.stationId === stationId));
    saveRecords(records);
    return res.json({ ok: true, removed: before - records.length });
  } catch(e){ console.error(e); return res.status(500).json({ message: 'Server error' }); }
});

// Development helper: auto-login a registered user without a password.
// This is provided so local development can quickly sign-in test accounts.
// DO NOT enable in production.
app.post('/api/auto-login', (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ message: 'Missing username' });
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ message: 'User not found' });
  // create token and set session for dev convenience
  const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: '2h' });
  req.session.user = username;
  return res.json({ user: username, auto: true, token });
});

app.listen(PORT, () => console.log(`StationSync server running on http://localhost:${PORT}`));
