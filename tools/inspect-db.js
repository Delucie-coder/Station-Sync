// tools/inspect-db.js
// Small helper to inspect SQLite schema and latest records
const path = require('path');
const DB_FILE = path.join(__dirname, '..', 'data.sqlite');
try{
  const Database = require('better-sqlite3');
  const db = new Database(DB_FILE, { readonly: true });
  console.log('Opened', DB_FILE);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
  console.log('Tables:', tables.join(', '));
  try{
    const cols = db.prepare("PRAGMA table_info(records)").all();
    console.log('records table columns:'); cols.forEach(c => console.log(` - ${c.name} (${c.type})`));
  } catch(e){ console.warn('Could not read records schema', e); }
  try{
    const rows = db.prepare('SELECT * FROM records ORDER BY created_at DESC LIMIT 10').all();
    console.log('Latest records (up to 10):');
    rows.forEach(r => console.log(JSON.stringify(r)));
  } catch(e){ console.warn('Could not read records rows', e); }
  db.close();
} catch(e){
  console.error('better-sqlite3 not installed or DB not available. Install with "npm install better-sqlite3" and ensure data.sqlite exists.');
  console.error(e && e.message ? e.message : e);
}
