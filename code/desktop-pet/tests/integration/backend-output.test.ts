import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const load = () => import(new URL('../../app/backend-output.js', import.meta.url).href);

test('a closed desktop pipe requests backend cleanup once and stops subsequent writes', async () => {
  const { createBackendOutput } = await load();
  let writes = 0, disconnects = 0;
  const stream = new Writable({ write(_chunk, _encoding, done) {
    writes++; done(Object.assign(new Error('Broken pipe'), { code: 'EPIPE' }));
  } });
  const output = createBackendOutput(stream, () => { disconnects++; });
  output.send({ channel: 'backend_ready' });
  await tick();
  output.send({ channel: 'event' });
  await tick();
  assert.equal(disconnects, 1);
  assert.equal(writes, 1);
});

test('normal shutdown suppresses final device messages and safely consumes late pipe errors', async () => {
  const { createBackendOutput } = await load();
  let writes = 0, disconnects = 0;
  const stream = new Writable({ write(_chunk, _encoding, done) { writes++; done(); } });
  const output = createBackendOutput(stream, () => { disconnects++; });
  output.close();
  output.send({ channel: 'capture_stop' });
  stream.emit('error', Object.assign(new Error('Broken pipe'), { code: 'EPIPE' }));
  stream.destroy();
  await tick();
  assert.equal(writes, 0);
  assert.equal(disconnects, 0);
});
