#!/usr/bin/env node
// scripts/restore-from-backup.js
// Lists available backups and restores the latest for each file, or specific backup filenames when provided.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const backupsDir = path.join(root, 'backups');
const usersFile = path.join(root, 'users.json');
const stationsFile = path.join(root, 'stations.json');
const recordsFile = path.join(root, 'records.json');

function listBackups(){
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir).sort();
}

function findLatest(base){
  const all = listBackups().filter(f => f.startsWith(base + '.'));
  if (!all.length) return null;
  return path.join(backupsDir, all[all.length-1]);
}

function restore(){
  if (!fs.existsSync(backupsDir)) return console.error('No backups directory found.');
  const latestUsers = findLatest('users.json');
  const latestStations = findLatest('stations.json');
  const latestRecords = findLatest('records.json');
  [ [latestUsers, usersFile], [latestStations, stationsFile], [latestRecords, recordsFile] ].forEach(pair => {
    const [src, dst] = pair;
    if (src && fs.existsSync(src)){
      fs.copyFileSync(src, dst);
      console.log('Restored', dst, 'from', src);
    } else {
      console.log('No backup found for', dst);
    }
  });
  console.log('Restore complete. If the server is running in JSON mode, it will pick up restored files on next read or you can restart the server.');
}

if (require.main === module) restore();

module.exports = { listBackups, restore };
