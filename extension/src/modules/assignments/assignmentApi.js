const BASE = 'http://localhost:5001/api/assignments';

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
  });
  let data;
  try { data = await response.json(); } catch {
    throw new Error(`Assignment server returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok || data.success === false) {
    const error = new Error(data.error || `Assignment request failed (HTTP ${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export const assignmentApi = {
  generate(body, signal) {
    return request('/generate', { method: 'POST', body: JSON.stringify(body), signal });
  },
  status(jobId, apiKey, requestId) {
    return request(`/jobs/${encodeURIComponent(jobId)}/status`, {
      method: 'POST', body: JSON.stringify({ apiKey, requestId }),
    });
  },
  cancel(jobId, apiKey) {
    return request(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST', body: JSON.stringify({ apiKey }),
    });
  },
};
