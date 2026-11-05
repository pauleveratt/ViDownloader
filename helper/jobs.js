// In-memory job registry shared by downloads, live recordings and tab recordings.
const crypto = require('crypto');
const fs = require('fs');

const jobs = new Map();
const KEEP_FINISHED = 40;

function createJob(type, fields = {}) {
  const job = {
    id: crypto.randomBytes(5).toString('hex'),
    type,                 // 'download' | 'live' | 'tabrec'
    status: 'running',    // running | processing | done | error | stopped
    stage: 'Starting',
    progress: null,       // 0-100, or null when unknown (live)
    speed: '',
    eta: '',
    bytes: 0,
    elapsed: 0,
    title: '',
    uploader: '',
    platform: '',
    url: '',
    files: [],
    error: '',
    createdAt: Date.now(),
    finishedAt: null,
    canStop: false,
    ...fields,
  };
  // Non-enumerable internals (process handles, stop hooks) so they never reach JSON.
  Object.defineProperty(job, '_procs', { value: new Set() });
  Object.defineProperty(job, '_onStop', { value: null, writable: true });
  jobs.set(job.id, job);
  prune();
  return job;
}

function finish(job, status, error) {
  job.status = status;
  job.canStop = false;
  job.finishedAt = Date.now();
  if (error) job.error = String(error.message || error);
  if (status === 'done') {
    job.progress = 100;
    job.fileBytes = job.files.reduce((n, f) => { try { return n + fs.statSync(f).size; } catch { return n; } }, 0);
  }
}

function prune() {
  const finished = [...jobs.values()].filter(j => j.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt);
  for (const j of finished.slice(KEEP_FINISHED)) jobs.delete(j.id);
}

function list() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function isBusy() {
  return list().some(j => !j.finishedAt);
}

module.exports = { jobs, createJob, finish, list, isBusy };
