import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSseEvent } from '../src/services/sse.js';
import { consumeSseStream } from '../../client/src/streaming.js';

test('SSE event formatter emits a named event with JSON data and a blank-line terminator', () => {
  assert.equal(formatSseEvent('token', { text: 'hello' }), 'event: token\ndata: {"text":"hello"}\n\n');
  assert.throws(() => formatSseEvent('bad event', {}), TypeError);
});

test('client SSE reader handles an event split between byte chunks', async () => {
  const frame = formatSseEvent('token', { text: '[2,' });
  const bytes = new TextEncoder().encode(frame);
  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 12));
      controller.enqueue(bytes.slice(12));
      controller.close();
    }
  }).getReader();
  const events = [];
  await consumeSseStream(reader, event => events.push(event));
  assert.deepEqual(events, [{ event: 'token', data: '{"text":"[2,"}' }]);
});

test('client SSE reader cancels immediately when its signal aborts before data arrives', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const controller = new AbortController();
  const consuming = consumeSseStream(stream.getReader(), () => assert.fail('no event expected'), controller.signal);
  controller.abort();
  await consuming;
  assert.equal(cancelled, true);
});
