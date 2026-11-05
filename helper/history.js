// Download history, one JSON object per line in history.jsonl.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'history.jsonl');

function append(entry) {
  const row = { id: crypto.randomBytes(5).toString('hex'), date: new Date().toISOString(), ...entry };
  fs.appendFileSync(FILE, JSON.stringify(row) + '\n');
  return row;
}

function read() {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return rows.reverse(); // newest first
}

function remove(id) {
  const rows = read().reverse().filter(r => r.id !== id);
  fs.writeFileSync(FILE, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

function clear() {
  fs.writeFileSync(FILE, '');
}

function knownFiles() {
  return new Set(read().map(r => r.file).filter(Boolean));
}

module.exports = { append, read, remove, clear, knownFiles };
