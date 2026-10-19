export function formatSseEvent(event, data) {
  if (!/^[a-z][a-z0-9_-]*$/i.test(event)) throw new TypeError('Invalid SSE event name');
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
