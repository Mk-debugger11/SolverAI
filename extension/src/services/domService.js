const API_BASE_URL = 'http://localhost:5001/api';

/**
 * Checks backend server and database health status.
 */
export async function checkBackendHealth() {
  try {
    const res = await fetch(`${API_BASE_URL}/health`);
    if (res.ok) {
      const data = await res.json();
      return { connected: true, database: data.database };
    }
    return { connected: false };
  } catch {
    return { connected: false };
  }
}

/**
 * Saves DOM capture and question records to MongoDB.
 */
export async function saveDomCapture(recordData) {
  const res = await fetch(`${API_BASE_URL}/dom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(recordData),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to save DOM capture');
  }
  return data;
}

/**
 * Loads recent saved DOM capture records.
 */
export async function fetchDomHistory() {
  const res = await fetch(`${API_BASE_URL}/dom`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to fetch history');
  }
  return data;
}

/**
 * Fetches a single DOM record with full HTML.
 */
export async function fetchDomRecordById(id) {
  const res = await fetch(`${API_BASE_URL}/dom/${id}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to fetch record');
  }
  return data;
}

/**
 * Deletes a saved DOM record by ID.
 */
export async function deleteDomRecord(id) {
  const res = await fetch(`${API_BASE_URL}/dom/${id}`, {
    method: 'DELETE',
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to delete record');
  }
  return data;
}
