export function notFound(_req, res) {
  res.status(404).json({ error: 'Route not found' });
}

export function errorHandler(error, _req, res, _next) {
  if (error.code === 11000) {
    if (error.keyPattern?.userId && error.keyPattern?.url) {
      return res.status(409).json({ error: 'This repository is already added.' });
    }
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  if (error.name === 'ValidationError') {
    return res.status(400).json({ error: 'Please check the submitted information' });
  }
  if (error.publicMessage && Number.isInteger(error.status) && error.status >= 400 && error.status < 600) {
    return res.status(error.status).json({ error: error.publicMessage });
  }
  const clientStatus = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    ? error.status
    : null;
  if (clientStatus) {
    const message = error.type === 'entity.parse.failed'
      ? 'Malformed JSON request'
      : error.type === 'entity.too.large'
        ? 'Request body too large'
        : error.publicMessage || 'Invalid request';
    return res.status(clientStatus).json({ error: message });
  }
  console.error(error);
  return res.status(500).json({ error: 'Internal server error' });
}
