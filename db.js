// db.js - SQLite helper using better-sqlite3
const fs = require('fs');
const path = require('path');
let Database;
try{
  Database = require('better-sqlite3');
}catch(e){
  console.warn('better-sqlite3 not installed. Run `npm install better-sqlite3` to enable SQLite storage.');
}

const DB_FILE = path.join(__dirname, 'data.sqlite');

function init(){
  if (!Database) return null;
  const db = new Database(DB_FILE);
  db.pragma('foreign_keys = ON');
  // create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT, contact TEXT, location TEXT, type TEXT,
      battery_count INTEGER, status TEXT, iot_status TEXT, created_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      station_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start_of_day INTEGER, given_out INTEGER, remaining INTEGER,
      need_repair INTEGER, damaged INTEGER, notes TEXT,
      created_at DATETIME, updated_at DATETIME,
      FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
    );
  `);
  return db;
}

function importFromJson(db, usersFile, stationsFile, recordsFile){
  // safe no-op if Database not present
  if (!Database || !db) return { imported: 0 };
  const users = JSON.parse(fs.existsSync(usersFile) ? fs.readFileSync(usersFile) : '[]');
  const stations = JSON.parse(fs.existsSync(stationsFile) ? fs.readFileSync(stationsFile) : '[]');
  const records = JSON.parse(fs.existsSync(recordsFile) ? fs.readFileSync(recordsFile) : '[]');
  const inserted = { users:0, stations:0, records:0 };

  const insertUser = db.prepare('INSERT OR IGNORE INTO users(username,password,created_at) VALUES(?,?,?)');
  const insertStation = db.prepare('INSERT OR IGNORE INTO stations(id,name,contact,location,type,battery_count,status,iot_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const insertRecord = db.prepare('INSERT OR IGNORE INTO records(id,station_id,date,start_of_day,given_out,remaining,need_repair,damaged,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');

  const utx = db.transaction((items)=>{
    items.forEach(u => { try{ insertUser.run(u.username, u.password || u.hash || '', u.createdAt || new Date().toISOString()); inserted.users++; }catch(e){} });
  });
  const stx = db.transaction((items)=>{
    items.forEach(s => { try{ insertStation.run(s.id, s.name, s.contact||'', s.location||'', s.type||'', s.batteryCount||0, s.status||'', s.iotStatus||'', s.createdAt||new Date().toISOString()); inserted.stations++; }catch(e){} });
  });
  const rtx = db.transaction((items)=>{
    items.forEach(r => { try{ insertRecord.run(r.id, r.stationId, r.date, r.startOfDay||0, r.givenOut||0, r.remaining||0, r.needRepair||0, r.damaged||0, r.notes||'', r.createdAt||new Date().toISOString(), r.updatedAt||null); inserted.records++; }catch(e){} });
  });

  try{ utx(users || []); stx(stations || []); rtx(records || []); }catch(e){ console.warn('Import error', e); }
  return inserted;
}

module.exports = { init, importFromJson };
