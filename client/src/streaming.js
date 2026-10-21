export function removeTrailingIncompleteCitation(answer) {
  return answer.replace(/\[\d+(?:\s*,\s*\d*)*\s*$/, '').trimEnd();
}

export const STREAM_ERROR_FALLBACK = "The model didn't respond. Try again in a minute.";

export function getStreamErrorMessage(eventData) {
  try {
    const payload = JSON.parse(eventData);
    return typeof payload.message === 'string' && payload.message.trim()
      ? payload.message
      : STREAM_ERROR_FALLBACK;
  } catch {
    return STREAM_ERROR_FALLBACK;
  }
}

export async function consumeSseStream(reader, onEvent, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let data = [];

  function dispatch() {
    if (data.length) onEvent({ event: eventName, data: data.join('\n') });
    eventName = 'message';
    data = [];
  }

  function consumeLines(final = false) {
    const lines = buffer.split(/\r?\n/);
    buffer = final ? '' : lines.pop();
    for (const line of lines) {
      if (line === '') { dispatch(); continue; }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') eventName = value;
      if (field === 'data') data.push(value);
    }
  }

  let abortListener;
  const aborted = signal && new Promise(resolve => {
    abortListener = () => resolve({ done: true });
    if (signal.aborted) abortListener();
    else signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    while (!signal?.aborted) {
      const read = reader.read();
      const result = signal ? await Promise.race([read, aborted]) : await read;
      if (signal?.aborted || result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      consumeLines();
    }
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
    if (signal?.aborted) reader.cancel().catch(() => {});
  }
  if (signal?.aborted) return;
  buffer += decoder.decode();
  consumeLines(true);
  dispatch();
}
