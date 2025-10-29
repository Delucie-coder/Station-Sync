#!/usr/bin/env node
// scripts/smoke-tests.js
// Simple smoke tests for auth, stations and records endpoints.
// Requires Node 18+ (global fetch) or appropriate polyfill.
const fetch = global.fetch || require('node-fetch');
const base = process.env.API_BASE || 'http://localhost:3000';

function rnd(n){ return Math.random().toString(36).slice(2, 2 + (n||6)); }
(async ()=>{
  try{
    console.log('Running smoke tests against', base);
    const username = 'test_' + rnd(4);
    const password = 'p@ss' + rnd(4);
    console.log('Registering user', username);
    let res = await fetch(base + '/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password }) });
    if (!res.ok) { console.error('Register failed', await res.text()); process.exit(2); }
    const jreg = await res.json(); console.log('Registered, token present?', !!jreg.token);
    console.log('Logging in...');
    res = await fetch(base + '/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password }) });
    if (!res.ok){ console.error('Login failed', await res.text()); process.exit(3); }
    const j = await res.json(); const token = j.token; console.log('Got token length', token ? token.length : 0);
    const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type':'application/json' };
    // create station
    const stPayload = { name: 'SmokeStation '+rnd(3), contact:'000', location:'Test', type:'Service', batteryCount:5, status:'Active', iotStatus:'Active' };
    res = await fetch(base + '/api/stations', { method:'POST', headers: auth, body: JSON.stringify(stPayload) });
    if (!res.ok){ console.error('Create station failed', await res.text()); process.exit(4); }
    const st = await res.json(); const stationId = st.station.id; console.log('Created station', stationId);
    // add record
    const rec = { date: new Date().toISOString().slice(0,10), startOfDay:10, givenOut:2, remaining:8, needRepair:0, damaged:0, notes:'smoke' };
    res = await fetch(`${base}/api/stations/${encodeURIComponent(stationId)}/records`, { method:'POST', headers: auth, body: JSON.stringify(rec) });
    if (!res.ok){ console.error('Add record failed', await res.text()); process.exit(5); }
    console.log('Record added');
    // fetch records
    res = await fetch(`${base}/api/stations/${encodeURIComponent(stationId)}/records`, { headers: auth });
    if (!res.ok){ console.error('Fetch records failed', await res.text()); process.exit(6); }
    const rj = await res.json(); console.log('Records count for station:', rj.records.length);
    // reports
    res = await fetch(base + '/api/reports/aggregate?period=month', { headers: auth });
    if (!res.ok){ console.error('Reports failed', await res.text()); process.exit(7); }
    console.log('Reports OK');
    // maintenance
    res = await fetch(base + '/api/maintenance', { headers: auth });
    if (!res.ok){ console.error('Maintenance failed', await res.text()); process.exit(8); }
    console.log('Maintenance OK');
    console.log('\nSmoke tests passed successfully.');
    process.exit(0);
  } catch(e){ console.error('Smoke test error', e); process.exit(1); }
})();
