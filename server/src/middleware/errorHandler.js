export function notFound(_req, res) {
  res.status(404).json({ error: 'Route not found' });
}

export function errorHandler(error, _req, res, _next) {
  console.error(error);
  if (error.code === 11000) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  if (error.name === 'ValidationError') {
    return res.status(400).json({ error: 'Please check the submitted information' });
  }
  return res.status(500).json({ error: 'Internal server error' });
}
