const DEVELOPMENT_ORIGIN = 'http://localhost:5173';

export function parseCorsOrigins(value) {
  return typeof value === 'string'
    ? [...new Set(value.split(',').map(origin => origin.trim()).filter(Boolean))]
    : [];
}

export function getAllowedCorsOrigins(env = process.env) {
  const configured = parseCorsOrigins(env.CORS_ORIGIN);
  if (env.NODE_ENV === 'production') return configured;
  return [...new Set([DEVELOPMENT_ORIGIN, ...configured])];
}

export function validateEnvironment(env = process.env) {
  if (env.NODE_ENV === 'production' && !parseCorsOrigins(env.CORS_ORIGIN).length) {
    throw new Error('CORS_ORIGIN must be set in production to list allowed browser origins.');
  }
  if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production.');
  }
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
  }
}
