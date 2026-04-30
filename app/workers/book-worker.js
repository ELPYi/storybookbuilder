'use strict';

const { parentPort, workerData } = require('worker_threads');

// Redirect stdout/stderr to parent thread as log messages
const origLog   = console.log.bind(console);
const origWarn  = console.warn.bind(console);
const origError = console.error.bind(console);

function send(text) {
  if (parentPort) parentPort.postMessage({ type: 'log', text });
  else origLog(text);
}

console.log  = (...a) => send(a.join(' ') + '\n');
console.warn  = (...a) => send(a.join(' ') + '\n');
console.error = (...a) => send(a.join(' ') + '\n');

const origStdoutWrite  = process.stdout.write.bind(process.stdout);
const origStderrWrite  = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => { send(chunk.toString()); return true; };
process.stderr.write = (chunk, ...rest) => { send(chunk.toString()); return true; };

// Apply env vars from workerData
if (workerData && workerData.env) {
  Object.assign(process.env, workerData.env);
}

const { main } = require('../../scripts/build-book.js');

main()
  .then(() => {
    if (parentPort) parentPort.postMessage({ type: 'done' });
  })
  .catch(err => {
    if (parentPort) parentPort.postMessage({ type: 'error', message: err.message });
    else process.exit(1);
  });
