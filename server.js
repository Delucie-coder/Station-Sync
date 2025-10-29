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

// Data files
const usersFile = path.join(__dirname, 'users.json');
const stationsFile = path.join(__dirname, 'stations.json');

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const data = fs.readFileSync(file);
    return JSON.parse(data);
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Load data
let users = readJSON(usersFile, []);
let stations = readJSON(stationsFile, []);

// Backwards-compat: if users file stores an object mapping username -> { hash }
// convert to the expected array format [{ id, username, password }]
if (users && !Array.isArray(users) && typeof users === 'object'){
  try{
    const converted = Object.keys(users).map((k, i) => {
      const entry = users[k];
      const hash = (entry && (entry.hash || entry.password)) ? (entry.hash || entry.password) : (typeof entry === 'string' ? entry : null);
      return { id: Date.now() + i, username: k, password: hash };
    });
    users = converted;
    writeJSON(usersFile, users);
    console.log('Converted users.json to array format for compatibility');
  } catch(e){ console.warn('Failed to convert users.json', e); }
}

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
  if (users.find(u => u.username === username))
    return res.status(400).json({ message: 'User already exists' });

  const hashed = await bcrypt.hash(password, 10);
  const user = { id: Date.now(), username, password: hashed };
  users.push(user);
  writeJSON(usersFile, users);

  const token = jwt.sign({ username }, SECRET, { expiresIn: '2h' });
  res.json({ user: username, token });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(`Login attempt for username='${username}'`);
  const user = users.find(u => u.username === username);
  if (!user) {
    console.log(` -> user not found`);
    return res.status(401).json({ message: 'User not found' });
  }

  try{
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) { console.log(' -> password mismatch'); return res.status(403).json({ message: 'Incorrect password' }); }
    const token = jwt.sign({ username }, SECRET, { expiresIn: '2h' });
    console.log(' -> login successful');
    res.json({ user: username, token });
  } catch(err){
    console.error('Error during login bcrypt:', err);
    return res.status(500).json({ message: 'Internal error' });
  }
});

// Dev helper: list usernames (useful for debugging client auto-login)
app.get('/api/users', (req, res) => {
  try{
    const list = (users || []).map(u => u.username);
    res.json({ users: list });
  } catch(e){ res.status(500).json({ message: 'Failed to list users' }); }
});

app.get('/api/session', authenticateToken, (req, res) => {
  res.json({ user: req.user.username });
});

// ===== STATION ROUTES =====
app.get('/api/stations', authenticateToken, (req, res) => {
  res.json({ stations });
});

app.post('/api/stations', authenticateToken, (req, res) => {
  const newStation = {
    id: 'ST' + Date.now().toString(36).slice(-5).toUpperCase(),
    ...req.body,
    createdAt: new Date().toISOString(),
  };
  stations.push(newStation);
  writeJSON(stationsFile, stations);
  res.json({ station: newStation });
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
