import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialTaskGate } from '../src/review/serialTaskGate';

test('timer tetiklemeleri üst üste bindiğinde ikinci çalışmayı atlar', async () => {
  const gate = new SerialTaskGate();
  let release: (() => void) | undefined;
  let executions = 0;
  const first = gate.tryRun(async () => {
    executions += 1;
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await Promise.resolve();

  const overlapping = await gate.tryRun(async () => { executions += 1; });
  assert.equal(overlapping, false);
  assert.equal(executions, 1);
  release?.();
  assert.equal(await first, true);
});

test('hata veren turdan sonra sonraki timer turuna izin verir', async () => {
  const gate = new SerialTaskGate();
  await assert.rejects(gate.tryRun(async () => { throw new Error('poll failed'); }));
  assert.equal(await gate.tryRun(async () => undefined), true);
});
