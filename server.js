// server.js
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const SECRET = 'station-sync-secret';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// Data files (keep as backup) and SQLite support
const usersFile = path.join(__dirname, 'users.json');
const stationsFile = path.join(__dirname, 'stations.json');
const recordsFile = path.join(__dirname, 'records.json');

// Try to initialize SQLite DB (optional). If better-sqlite3 is not installed we fall back to JSON files.
let db = null;
let useSqlite = false;
try{
  const dbModule = require('./db');
  db = dbModule.init();
  if (db) { useSqlite = true; console.log('Using SQLite storage at data.sqlite');
    // backup JSON files before import
    try{
      backupJsonFiles();
    } catch(e){ console.warn('Backup step failed', e); }
    // import existing JSON into SQLite on first run
    const imported = dbModule.importFromJson(db, usersFile, stationsFile, recordsFile);
    if (imported && (imported.users || imported.stations || imported.records)){
      console.log('Imported data into SQLite:', imported);
    }
  } else {
    console.log('SQLite not available — using JSON files');
  }
}catch(e){ console.warn('SQLite init error, falling back to JSON storage', e); }

function readJSON(file, fallback) {
  try { if (!fs.existsSync(file)) return fallback; const data = fs.readFileSync(file); return JSON.parse(data); } catch { return fallback; }
}
function writeJSON(file, data) {
  // Atomic write: write to a temp file then rename
  try{
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) try{ fs.mkdirSync(dir, { recursive: true }); } catch(e){}
    const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch(e){
    console.warn('Atomic write failed for', file, e);
    try{ fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; } catch(e2){ console.error('Fallback write failed', e2); return false; }
  }
}

// Automatic periodic backups (JSON mode)
const AUTO_BACKUP_INTERVAL_MS = process.env.AUTO_BACKUP_INTERVAL_MS ? Number(process.env.AUTO_BACKUP_INTERVAL_MS) : (10 * 60 * 1000);
if (!useSqlite){
  try{
    setInterval(()=>{ try{ backupJsonFiles(); } catch(e){ console.warn('Auto-backup failed', e); } }, AUTO_BACKUP_INTERVAL_MS);
    console.log('Auto-backup enabled. Interval (ms):', AUTO_BACKUP_INTERVAL_MS);
  } catch(e){ console.warn('Failed to start auto-backup', e); }
}

// Manual backup endpoint
app.post('/api/backup-json', authenticateToken, (req, res) => {
  try{
    const ok = backupJsonFiles();
    if (!ok) return res.status(500).json({ message: 'Backup failed' });
    res.json({ backed: true });
  } catch(e){ res.status(500).json({ message: 'Backup error' }); }
});

// If not using sqlite, load data into memory
let users = [], stations = [], records = [];
if (!useSqlite){
  users = readJSON(usersFile, []);
  stations = readJSON(stationsFile, []);
  records = readJSON(recordsFile, []);
  // Backwards-compat conversion for legacy users object
  if (users && !Array.isArray(users) && typeof users === 'object'){
    try{ const converted = Object.keys(users).map((k, i) => { const entry = users[k]; const hash = (entry && (entry.hash || entry.password)) ? (entry.hash || entry.password) : (typeof entry === 'string' ? entry : null); return { id: Date.now() + i, username: k, password: hash }; }); users = converted; writeJSON(usersFile, users); console.log('Converted users.json to array format for compatibility'); } catch(e){ console.warn('Failed to convert users.json', e); }
  }
}

// Create a developer/test user automatically when running in non-production
try{
  const DEV_USER = process.env.DEV_TEST_USER || 'dev';
  const DEV_PASS = process.env.DEV_TEST_PASS || 'devpass';
  if (process.env.NODE_ENV !== 'production'){
    // If using sqlite, insert into users table if missing
    if (useSqlite && db){
      try{
        const found = db.prepare('SELECT * FROM users WHERE username = ?').get(DEV_USER);
        if (!found){ const hash = bcrypt.hashSync(DEV_PASS, 10); db.prepare('INSERT INTO users(username,password,created_at) VALUES(?,?,?)').run(DEV_USER, hash, new Date().toISOString()); console.log(`✅ Created dev user '${DEV_USER}' with password from DEV_TEST_PASS or default`); }
      } catch(e){ console.warn('Failed to create dev user in sqlite', e); }
    } else {
      try{
        if (!users.find(u => u.username === DEV_USER)){
          const hash = bcrypt.hashSync(DEV_PASS, 10);
          users.push({ id: Date.now(), username: DEV_USER, password: hash });
          writeJSON(usersFile, users);
          console.log(`✅ Created dev user '${DEV_USER}' in users.json (password from DEV_TEST_PASS or default)`);
        }
      } catch(e){ console.warn('Failed to create dev user in users.json', e); }
    }
  }
} catch(e){ console.warn('Dev user creation skipped', e); }

// JWT middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ===== AUTH ROUTES =====
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'username and password required' });
  try{
    const hashed = await bcrypt.hash(password, 10);
    if (useSqlite){
      const exist = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
      if (exist) return res.status(400).json({ message: 'User already exists' });
      db.prepare('INSERT INTO users(username,password,created_at) VALUES(?,?,?)').run(username, hashed, new Date().toISOString());
    } else {
      if (users.find(u => u.username === username)) return res.status(400).json({ message: 'User already exists' });
      const user = { id: Date.now(), username, password: hashed };
      users.push(user); writeJSON(usersFile, users);
    }
    const token = jwt.sign({ username }, SECRET, { expiresIn: '2h' });
    res.json({ user: username, token });
  } catch(e){ console.error('register error', e); res.status(500).json({ message: 'Register failed' }); }
});

// Password reset request: generate a one-time token (dev: returned in response)
app.post('/api/request-password-reset', async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ message: 'username required' });
  try{
    const token = Math.random().toString(36).slice(2,10).toUpperCase();
    const expiry = new Date(Date.now() + (1000 * 60 * 30)).toISOString(); // 30 minutes
    if (useSqlite){
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user) return res.status(404).json({ message: 'User not found' });
      db.prepare('UPDATE users SET reset_token = ?, reset_expiry = ? WHERE username = ?').run(token, expiry, username);
    } else {
      const u = users.find(u => u.username === username);
      if (!u) return res.status(404).json({ message: 'User not found' });
      u.reset_token = token; u.reset_expiry = expiry; writeJSON(usersFile, users);
    }
    // In a real app we would email the token; for the prototype return it in the response so the user can copy it
    res.json({ token, expiry, message: 'Reset token generated (development mode — token returned in response)' });
  } catch(e){ console.error('reset request error', e); res.status(500).json({ message: 'Failed to generate reset token' }); }
});

// Perform password reset using token
app.post('/api/reset-password', async (req, res) => {
  const { username, token, newPassword } = req.body || {};
  if (!username || !token || !newPassword) return res.status(400).json({ message: 'username, token and newPassword required' });
  try{
    if (useSqlite){
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user) return res.status(404).json({ message: 'User not found' });
      if (!user.reset_token || String(user.reset_token) !== String(token)) return res.status(403).json({ message: 'Invalid token' });
      if (user.reset_expiry && new Date(user.reset_expiry) < new Date()) return res.status(403).json({ message: 'Token expired' });
      const hashed = await bcrypt.hash(newPassword, 10);
      db.prepare('UPDATE users SET password = ?, reset_token = NULL, reset_expiry = NULL WHERE username = ?').run(hashed, username);
      return res.json({ message: 'Password reset successful' });
    } else {
      const u = users.find(u => u.username === username);
      if (!u) return res.status(404).json({ message: 'User not found' });
      if (!u.reset_token || String(u.reset_token) !== String(token)) return res.status(403).json({ message: 'Invalid token' });
      if (u.reset_expiry && new Date(u.reset_expiry) < new Date()) return res.status(403).json({ message: 'Token expired' });
      const hashed = await bcrypt.hash(newPassword, 10);
      u.password = hashed; u.reset_token = null; u.reset_expiry = null; writeJSON(usersFile, users);
      return res.json({ message: 'Password reset successful' });
    }
  } catch(e){ console.error('reset perform error', e); res.status(500).json({ message: 'Failed to reset password' }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(`Login attempt for username='${username}'`);
  try{
    let row = null;
    if (useSqlite){ row = db.prepare('SELECT * FROM users WHERE username = ?').get(username); }
    else { row = (users || []).find(u => u.username === username); }
    if (!row) { console.log(' -> user not found'); return res.status(401).json({ message: 'User not found' }); }
    const hash = row.password || row.hash;
    const valid = await bcrypt.compare(password, hash);
    if (!valid) { console.log(' -> password mismatch'); return res.status(403).json({ message: 'Incorrect password' }); }
    const token = jwt.sign({ username }, SECRET, { expiresIn: '2h' });
    console.log(' -> login successful'); res.json({ user: username, token });
  } catch(err){ console.error('Error during login:', err); res.status(500).json({ message: 'Internal error' }); }
});

// Dev helper: list usernames (useful for debugging client auto-login)
app.get('/api/users', (req, res) => {
  try{
    if (useSqlite){ const rows = db.prepare('SELECT username FROM users').all(); return res.json({ users: rows.map(r=>r.username) }); }
    const list = (users || []).map(u => u.username); res.json({ users: list });
  } catch(e){ res.status(500).json({ message: 'Failed to list users' }); }
});

// Backup helper: copy JSON files to backups/ with timestamped names
function backupJsonFiles(){
  try{
    const backupsDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir);
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    [usersFile, stationsFile, recordsFile].forEach(f => {
      try{
        if (fs.existsSync(f)){
          const base = path.basename(f);
          const dst = path.join(backupsDir, base + '.' + ts + '.bak');
          fs.copyFileSync(f, dst);
        }
      } catch(e){ console.warn('Failed to backup', f, e); }
    });
    console.log('Backed up JSON files to', backupsDir);
    return true;
  } catch(e){ console.warn('BackupJsonFiles error', e); return false; }
}

app.get('/api/session', authenticateToken, (req, res) => {
  res.json({ user: req.user.username });
});

// ===== STATION ROUTES =====
app.get('/api/stations', authenticateToken, (req, res) => {
  try{
    if (useSqlite){ const rows = db.prepare('SELECT * FROM stations').all(); return res.json({ stations: rows }); }
    res.json({ stations });
  } catch(e){ res.status(500).json({ message: 'Failed to list stations' }); }
});

app.post('/api/stations', authenticateToken, (req, res) => {
  try{
    const newStation = Object.assign({ id: 'ST' + Date.now().toString(36).slice(-5).toUpperCase(), createdAt: new Date().toISOString() }, req.body);
    if (useSqlite){ db.prepare('INSERT INTO stations(id,name,contact,location,type,battery_count,status,iot_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(newStation.id, newStation.name, newStation.contact||'', newStation.location||'', newStation.type||'', newStation.batteryCount||0, newStation.status||'', newStation.iotStatus||'', newStation.createdAt); return res.json({ station: newStation }); }
    stations.push(newStation); writeJSON(stationsFile, stations); res.json({ station: newStation });
  } catch(e){ res.status(500).json({ message: 'Failed to add station' }); }
});

// Update a station
app.put('/api/stations/:id', authenticateToken, (req, res) => {
  try{
    const id = req.params.id; const payload = req.body || {};
    if (useSqlite){
      db.prepare('UPDATE stations SET name=?, contact=?, location=?, type=?, battery_count=? WHERE id=?').run(payload.name||'', payload.contact||'', payload.location||'', payload.type||'', payload.batteryCount||0, id);
      const updated = db.prepare('SELECT * FROM stations WHERE id = ?').get(id);
      return res.json({ station: updated });
    }
    const idx = stations.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Station not found' });
    stations[idx] = Object.assign({}, stations[idx], { name: payload.name, contact: payload.contact, location: payload.location, type: payload.type, batteryCount: payload.batteryCount });
    writeJSON(stationsFile, stations);
    res.json({ station: stations[idx] });
  } catch(e){ res.status(500).json({ message: 'Failed to update station' }); }
});

// Delete a station
app.delete('/api/stations/:id', authenticateToken, (req, res) => {
  try{
    const id = req.params.id;
    if (useSqlite){ const existing = db.prepare('SELECT * FROM stations WHERE id = ?').get(id); if (!existing) return res.status(404).json({ message: 'Station not found' }); db.prepare('DELETE FROM stations WHERE id = ?').run(id); return res.json({ deleted: true, station: existing }); }
    const idx = stations.findIndex(s => s.id === id); if (idx === -1) return res.status(404).json({ message: 'Station not found' }); const removed = stations.splice(idx,1)[0]; writeJSON(stationsFile, stations); res.json({ deleted: true, station: removed });
  } catch(e){ res.status(500).json({ message: 'Failed to delete station' }); }
});

// ===== RECORDS =====
// Get records for a station, optionally filtered by date range (?from=YYYY-MM-DD&to=YYYY-MM-DD)
app.get('/api/stations/:id/records', authenticateToken, (req, res) => {
  try{
    const stationId = req.params.id; const from = req.query.from; const to = req.query.to;
    if (useSqlite){
      let sql = 'SELECT * FROM records WHERE station_id = ?'; const params = [stationId];
      if (from) { sql += ' AND date >= ?'; params.push(from); }
      if (to) { sql += ' AND date <= ?'; params.push(to); }
      sql += ' ORDER BY date DESC';
      const rows = db.prepare(sql).all(...params);
      return res.json({ records: rows });
    }
    let list = records.filter(r => r.stationId === stationId);
    if (from) list = list.filter(r => r.date >= from);
    if (to) list = list.filter(r => r.date <= to);
    list.sort((a,b)=> b.date.localeCompare(a.date));
    res.json({ records: list });
  } catch(e){ res.status(500).json({ message: 'Failed to load records' }); }
});

// Create or upsert a record for a station (unique by stationId+date)
app.post('/api/stations/:id/records', authenticateToken, (req, res) => {
  try{
    const stationId = req.params.id; const payload = req.body || {};
    if (!payload.date) return res.status(400).json({ message: 'date is required' });
    if (useSqlite){
      // check existing
      const existing = db.prepare('SELECT * FROM records WHERE station_id = ? AND date = ?').get(stationId, payload.date);
  if (existing){ db.prepare('UPDATE records SET start_of_day=?,given_out=?,remaining=?,need_repair=?,damaged=?,earnings=?,notes=?,updated_at=? WHERE id=?').run(payload.startOfDay||0,payload.givenOut||0,payload.remaining||0,payload.needRepair||0,payload.damaged||0, Number(payload.earnings||0), payload.notes||'',new Date().toISOString(), existing.id); const updated = db.prepare('SELECT * FROM records WHERE id=?').get(existing.id); return res.json({ record: updated, upsert: true }); }
  const id = 'RC' + Date.now().toString(36).slice(-6).toUpperCase(); db.prepare('INSERT INTO records(id,station_id,date,start_of_day,given_out,remaining,need_repair,damaged,earnings,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, stationId, payload.date, payload.startOfDay||0, payload.givenOut||0, payload.remaining||0, payload.needRepair||0, payload.damaged||0, Number(payload.earnings||0), payload.notes||'', new Date().toISOString()); const newRec = db.prepare('SELECT * FROM records WHERE id = ?').get(id); return res.json({ record: newRec });
    }
    const existing = records.find(r => r.stationId === stationId && r.date === payload.date);
    if (existing){ Object.assign(existing, payload, { updatedAt: new Date().toISOString() }); writeJSON(recordsFile, records); return res.json({ record: existing, upsert: true }); }
    const newRec = Object.assign({ id: 'RC' + Date.now().toString(36).slice(-6).toUpperCase(), stationId, createdAt: new Date().toISOString() }, payload);
    records.push(newRec); writeJSON(recordsFile, records); res.json({ record: newRec });
  } catch(e){ res.status(500).json({ message: 'Failed to save record' }); }
});

// Update a record by id
app.put('/api/stations/:id/records/:rid', authenticateToken, (req, res) => {
  try{
    const rid = req.params.rid; const payload = req.body || {};
  if (useSqlite){ const existing = db.prepare('SELECT * FROM records WHERE id = ?').get(rid); if (!existing) return res.status(404).json({ message: 'Record not found' }); db.prepare('UPDATE records SET date=?,start_of_day=?,given_out=?,remaining=?,need_repair=?,damaged=?,earnings=?,notes=?,updated_at=? WHERE id=?').run(payload.date||existing.date,payload.startOfDay||existing.start_of_day,payload.givenOut||existing.given_out,payload.remaining||existing.remaining,payload.needRepair||existing.need_repair,payload.damaged||existing.damaged, Number(payload.earnings!==undefined ? payload.earnings : (existing.earnings || 0)),payload.notes||existing.notes,new Date().toISOString(), rid); const updated = db.prepare('SELECT * FROM records WHERE id=?').get(rid); return res.json({ record: updated }); }
    const idx = records.findIndex(r => r.id === rid); if (idx === -1) return res.status(404).json({ message: 'Record not found' }); Object.assign(records[idx], payload, { updatedAt: new Date().toISOString() }); writeJSON(recordsFile, records); res.json({ record: records[idx] });
  } catch(e){ res.status(500).json({ message: 'Failed to update record' }); }
});

// Delete a record
app.delete('/api/stations/:id/records/:rid', authenticateToken, (req, res) => {
  try{
    const rid = req.params.rid;
    if (useSqlite){ const existing = db.prepare('SELECT * FROM records WHERE id = ?').get(rid); if (!existing) return res.status(404).json({ message: 'Record not found' }); db.prepare('DELETE FROM records WHERE id = ?').run(rid); return res.json({ deleted:true, record: existing }); }
    const idx = records.findIndex(r => r.id === rid); if (idx === -1) return res.status(404).json({ message: 'Record not found' }); const removed = records.splice(idx,1)[0]; writeJSON(recordsFile, records); res.json({ deleted: true, record: removed });
  } catch(e){ res.status(500).json({ message: 'Failed to delete record' }); }
});

// Maintenance report: return latest records that indicate needRepair>0 or damaged>0
app.get('/api/stations/:id/records/maintenance', authenticateToken, (req, res) => {
  try{
    const stationId = req.params.id;
    if (useSqlite){ const rows = db.prepare('SELECT * FROM records WHERE station_id = ? AND (COALESCE(need_repair,0) > 0 OR COALESCE(damaged,0) > 0)').all(stationId); return res.json({ records: rows }); }
    const list = records.filter(r => r.stationId === stationId && ((Number(r.needRepair)||0) > 0 || (Number(r.damaged)||0) > 0)); res.json({ records: list });
  } catch(e){ res.status(500).json({ message: 'Failed to load maintenance records' }); }
});

// Global maintenance report: stations with repairs/damaged counts
app.get('/api/maintenance', authenticateToken, (req, res) => {
  try{
    if (useSqlite){
      const rows = db.prepare('SELECT station_id, SUM(COALESCE(need_repair,0)) as needRepair, SUM(COALESCE(damaged,0)) as damaged, MAX(date) as lastDate FROM records WHERE COALESCE(need_repair,0) > 0 OR COALESCE(damaged,0) > 0 GROUP BY station_id').all();
      const result = rows.map(r => { const st = db.prepare('SELECT * FROM stations WHERE id = ?').get(r.station_id) || { id: r.station_id, name: r.station_id }; return { station: st, needRepair: r.needRepair, damaged: r.damaged, lastRecord: { date: r.lastDate } }; });
      return res.json({ maintenance: result });
    }
    const byStation = {};
    records.forEach(r => {
      if ((Number(r.needRepair)||0) > 0 || (Number(r.damaged)||0) > 0){
        const s = r.stationId;
        byStation[s] = byStation[s] || { stationId: s, needRepair: 0, damaged: 0, lastRecord: null };
        byStation[s].needRepair += Number(r.needRepair)||0;
        byStation[s].damaged += Number(r.damaged)||0;
        if (!byStation[s].lastRecord || (r.date > byStation[s].lastRecord.date)) byStation[s].lastRecord = r;
      }
    });
    // attach station info
    const result = Object.keys(byStation).map(sid => {
      const st = stations.find(x => x.id === sid) || { id: sid, name: sid };
      return Object.assign({}, { station: st }, byStation[sid]);
    });
    res.json({ maintenance: result });
  } catch(e){ res.status(500).json({ message: 'Failed to compute maintenance report' }); }
});

// Aggregated reports endpoint: totals per month or year for givenOut/given counts
// GET /api/reports/aggregate?period=month|year&from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/reports/aggregate', authenticateToken, (req, res) => {
  try{
    const period = (req.query.period || 'month');
    const from = req.query.from; const to = req.query.to;
    let set = [];
    if (useSqlite){
      let sql = 'SELECT * FROM records WHERE 1=1'; const params = [];
      if (from) { sql += ' AND date >= ?'; params.push(from); }
      if (to) { sql += ' AND date <= ?'; params.push(to); }
      sql += ' ORDER BY date ASC';
      set = db.prepare(sql).all(...params);
    } else {
      set = records.slice(); if (from) set = set.filter(r => r.date >= from); if (to) set = set.filter(r => r.date <= to);
    }
    const buckets = {};
    set.forEach(r => {
      let key = r.date;
      if (period === 'month') key = r.date.slice(0,7); // YYYY-MM
      else if (period === 'year') key = r.date.slice(0,4); // YYYY
      buckets[key] = buckets[key] || { givenOut: 0, remaining: 0, earnings: 0, count: 0 };
      buckets[key].givenOut += Number(r.givenOut)||0;
      buckets[key].remaining += Number(r.remaining)||0;
      // support various possible earnings field names
      const earningsVal = Number(r.earnings || r.earning || r.earnings_amount || 0) || 0;
      buckets[key].earnings += earningsVal;
      buckets[key].count += 1;
    });
    // sort keys
    const keys = Object.keys(buckets).sort();
  const data = keys.map(k => ({ period: k, givenOut: buckets[k].givenOut, remaining: buckets[k].remaining, earnings: buckets[k].earnings || 0, count: buckets[k].count }));
    res.json({ period: period, data });
  } catch(e){ res.status(500).json({ message: 'Failed to compute aggregate report' }); }
});

// Endpoint to force/import JSON -> SQLite on demand
app.post('/api/migrate-to-sqlite', authenticateToken, (req, res) => {
  if (!db) return res.status(500).json({ message: 'SQLite not initialized on server' });
  try{
    // backup first
    const backed = backupJsonFiles();
    const imported = require('./db').importFromJson(db, usersFile, stationsFile, recordsFile);
    res.json({ migrated: imported, backup: !!backed });
  } catch(e){ res.status(500).json({ message: 'Migration failed' }); }
});

// Helper: find latest backup file for a given base name
function findLatestBackup(baseName){
  try{
    const backupsDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupsDir)) return null;
    const files = fs.readdirSync(backupsDir).filter(f => f.startsWith(baseName + '.')).sort();
    if (!files.length) return null;
    return path.join(backupsDir, files[files.length-1]);
  } catch(e){ return null; }
}

// Restore helper: copy chosen backup files into active JSON files (optionally reload in-memory state)
function restoreFromBackup(options){
  try{
    const backupsDir = path.join(__dirname, 'backups'); if (!fs.existsSync(backupsDir)) return { restored: 0 };
    const result = { restored: 0, files: [] };
    const mapping = [ ['users', usersFile], ['stations', stationsFile], ['records', recordsFile] ];
    mapping.forEach(([key, dest]) => {
      const candidate = options && options.files && options.files[key] ? path.join(backupsDir, options.files[key]) : findLatestBackup(path.basename(dest));
      if (candidate && fs.existsSync(candidate)){
        fs.copyFileSync(candidate, dest);
        result.restored++; result.files.push({ dest, from: candidate });
      }
    });
    // if not using sqlite, reload in-memory arrays
    if (!useSqlite){
      users = readJSON(usersFile, []);
      stations = readJSON(stationsFile, []);
      records = readJSON(recordsFile, []);
    }
    return result;
  } catch(e){ return { restored: 0, error: String(e) }; }
}

// Restore endpoint: POST /api/restore-from-backup { files: { users: 'users.json.TIMESTAMP.bak', stations:..., records:... } }
app.post('/api/restore-from-backup', authenticateToken, (req, res) => {
  try{
    const payload = req.body || {};
    const restored = restoreFromBackup(payload);
    if (restored.error) return res.status(500).json({ message: 'Restore failed', error: restored.error });
    res.json({ restored });
  } catch(e){ res.status(500).json({ message: 'Restore failed' }); }
});

// List available backup files
app.get('/api/list-backups', authenticateToken, (req, res) => {
  try{
    const backupsDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupsDir)) return res.json({ backups: [] });
    const files = fs.readdirSync(backupsDir).sort();
    res.json({ backups: files });
  } catch(e){ res.status(500).json({ message: 'Failed to list backups' }); }
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
