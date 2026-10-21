export function formatSseEvent(event, data) {
  if (!/^[a-z][a-z0-9_-]*$/i.test(event)) throw new TypeError('Invalid SSE event name');
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function startSseHeartbeat(res, intervalMs = 15_000) {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    res.removeListener('close', stop);
    res.removeListener('finish', stop);
  };
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded || !res.writable) {
      stop();
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch {
      stop();
    }
  }, intervalMs);
  timer.unref?.();
  res.once('close', stop);
  res.once('finish', stop);
  return stop;
}
