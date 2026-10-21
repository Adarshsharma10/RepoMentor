import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { formatSseEvent, startSseHeartbeat } from '../src/services/sse.js';
import { consumeSseStream, getStreamErrorMessage, STREAM_ERROR_FALLBACK } from '../../client/src/streaming.js';

test('SSE event formatter emits a named event with JSON data and a blank-line terminator', () => {
  assert.equal(formatSseEvent('token', { text: 'hello' }), 'event: token\ndata: {"text":"hello"}\n\n');
  assert.throws(() => formatSseEvent('bad event', {}), TypeError);
});

test('SSE heartbeat sends ping comments and clears on response close', async () => {
  const response = new EventEmitter();
  const writes = [];
  Object.assign(response, { destroyed: false, writableEnded: false, writable: true });
  response.write = value => { writes.push(value); return true; };
  startSseHeartbeat(response, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  response.emit('close');
  const countAtClose = writes.length;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(countAtClose > 0);
  assert.equal(writes.every(value => value === ': ping\n\n'), true);
  assert.equal(writes.length, countAtClose);
});

test('client SSE reader handles an event split between byte chunks', async () => {
  const frame = `: ping\n\n${formatSseEvent('token', { text: '[2,' })}`;
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

test('client SSE parser preserves error-event messages and supplies a fallback when missing', async () => {
  const bytes = new TextEncoder().encode(
    `${formatSseEvent('error', { message: 'The answer service is busy.' })}${formatSseEvent('error', {})}`
  );
  const reader = new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); }
  }).getReader();
  const messages = [];
  await consumeSseStream(reader, event => {
    if (event.event === 'error') messages.push(getStreamErrorMessage(event.data));
  });
  assert.deepEqual(messages, ['The answer service is busy.', STREAM_ERROR_FALLBACK]);
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
