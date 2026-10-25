// The worker SeerrClient.titleRequests parses title answers in (see parseTitleAnswer).
import { parentPort } from 'node:worker_threads';
import { parseTitleAnswer } from './seerr-title.js';

parentPort?.on('message', ({ id, bytes }: { id: number; bytes: Uint8Array }) => {
  try {
    parentPort?.postMessage({ id, record: parseTitleAnswer(bytes) });
  } catch {
    parentPort?.postMessage({ id });
  }
});
