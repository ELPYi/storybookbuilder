'use strict';

const { parentPort, workerData } = require('worker_threads');

const origLog   = console.log.bind(console);
const origWarn  = console.warn.bind(console);
const origError = console.error.bind(console);

function send(text) {
  if (parentPort) parentPort.postMessage({ type: 'log', text });
  else origLog(text);
}

console.log   = (...a) => send(a.join(' ') + '\n');
console.warn  = (...a) => send(a.join(' ') + '\n');
console.error = (...a) => send(a.join(' ') + '\n');

process.stdout.write = (chunk) => { send(chunk.toString()); return true; };
process.stderr.write = (chunk) => { send(chunk.toString()); return true; };

if (workerData && workerData.env) {
  Object.assign(process.env, workerData.env);
}

const { main } = require('../../scripts/lyrics-video.js');

main()
  .then(() => {
    if (parentPort) parentPort.postMessage({ type: 'done' });
  })
  .catch(err => {
    if (parentPort) parentPort.postMessage({ type: 'error', message: err.message });
    else process.exit(1);
  });
