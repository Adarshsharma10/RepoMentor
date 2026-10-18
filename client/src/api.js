export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export async function apiRequest(path, options = {}) {
  const token = localStorage.getItem('repomentor-token');
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'The request could not be completed. Check the details and try again.');
    error.data = data;
    throw error;
  }
  return data;
}

export function userFacingError(error, fallback = 'The request could not be completed. Check the details and try again.') {
  if (error?.message === 'Failed to fetch') return 'Can’t reach RepoMentor. Check that the server is running.';
  if (/answer service|could not generate an answer|model/i.test(error?.message || '')) {
    return 'The model didn’t respond. Try again in a minute.';
  }
  return error?.message || fallback;
}
