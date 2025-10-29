#!/usr/bin/env node
// scripts/migrate-to-sqlite.js
// Standalone migration script: backups JSON files and imports into data.sqlite using db.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const usersFile = path.join(root, 'users.json');
const stationsFile = path.join(root, 'stations.json');
const recordsFile = path.join(root, 'records.json');

function backupJsonFiles(){
  try{
    const backupsDir = path.join(root, 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir);
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    [usersFile, stationsFile, recordsFile].forEach(f => {
      try{ if (fs.existsSync(f)){ const base = path.basename(f); const dst = path.join(backupsDir, base + '.' + ts + '.bak'); fs.copyFileSync(f, dst); } } catch(e){ console.warn('Failed to backup', f, e); }
    });
    console.log('Backed up JSON files to', backupsDir);
    return true;
  } catch(e){ console.warn('BackupJsonFiles error', e); return false; }
}

async function run(){
  console.log('Starting migration to SQLite...');
  const backed = backupJsonFiles();
  try{
    const dbModule = require(path.join(root, 'db'));
    const db = dbModule.init();
    if (!db){ console.error('SQLite not available. Install better-sqlite3 and try again.'); process.exit(2); }
    const imported = dbModule.importFromJson(db, usersFile, stationsFile, recordsFile);
    console.log('Import result:', imported);
    console.log('Migration complete.');
    process.exit(0);
  } catch(e){
    console.error('Migration failed:', e);
    process.exit(1);
  }
}

run();
