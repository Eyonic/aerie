import { getToken, setToken } from './api';

export type TimeMachineEntry = {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtimeMs: number;
  mode: number;
  ctimeMs?: number;
  ino?: number;
  dev?: number;
  sha256?: string;
  linkTarget?: string;
};

export type TimeMachineSnapshot = {
  id: string;
  createdAt: string;
  label: string | null;
  entryCount: number;
  fileCount: number;
  totalBytes: number;
  warningCount: number;
  manifestHash: string;
};

export type TimeMachineTask = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  label: string | null;
  currentPath: string | null;
  processedFiles: number;
  processedBytes: number;
  snapshotId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TimeMachineRetention = {
  enabled: boolean;
  intervalHours: number;
  hourlyHours: number;
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
  minimumSnapshots: number;
  maximumBytes: number | null;
  lastSnapshotAt: string | null;
};

export type TimeMachineDiff = {
  against: string;
  path: string;
  summary: { added: number; removed: number; modified: number; typeChanged: number; unchanged: number };
  total: number;
  offset: number;
  limit: number;
  changes: { path: string; change: 'added' | 'removed' | 'modified' | 'type-changed'; before?: TimeMachineEntry; after?: TimeMachineEntry }[];
};

class TimeMachineError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 401) {
    setToken(null);
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new TimeMachineError(401, 'unauthorized');
  }
  if (!response.ok) {
    let message = response.statusText || 'request_failed';
    try { message = (await response.json()).error || message; } catch { /* non-JSON failure */ }
    throw new TimeMachineError(response.status, message);
  }
  return response.json();
}

const query = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  return params.toString();
};

export const timeMachineApi = {
  snapshots: () => request<{ snapshots: TimeMachineSnapshot[] }>('GET', '/api/time-machine/snapshots'),
  create: (label?: string) => request<{ task: TimeMachineTask }>('POST', '/api/time-machine/snapshots', { label }),
  task: (id: string) => request<{ task: TimeMachineTask }>('GET', `/api/time-machine/tasks/${encodeURIComponent(id)}`),
  latestTask: () => request<{ task: TimeMachineTask | null }>('GET', '/api/time-machine/tasks/latest'),
  remove: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/time-machine/snapshots/${encodeURIComponent(id)}`),
  tree: (id: string, path = '/') => request<{ path: string; entry: TimeMachineEntry; entries: TimeMachineEntry[]; warnings: string[] }>(
    'GET', `/api/time-machine/snapshots/${encodeURIComponent(id)}/tree?${query({ path })}`),
  diff: (id: string, path = '/', against = 'current') => request<TimeMachineDiff>('GET',
    `/api/time-machine/snapshots/${encodeURIComponent(id)}/diff?${query({ path, against, limit: 1000 })}`),
  restore: (id: string, data: { path: string; destinationPath?: string; mode: 'skip' | 'rename' | 'overwrite' }) =>
    request<{ destinationPath: string; restored: number; skipped: number; replaced: boolean; sync?: { reconciled: boolean; error?: string } }>('POST',
      `/api/time-machine/snapshots/${encodeURIComponent(id)}/restore`, data),
  retention: () => request<TimeMachineRetention>('GET', '/api/time-machine/retention'),
  saveRetention: (policy: TimeMachineRetention) => request<TimeMachineRetention>('PUT', '/api/time-machine/retention', policy),
  prune: () => request<{ removedSnapshots: number; removedObjects: number; removedBytes: number; skipped: boolean }>('POST', '/api/time-machine/retention/prune'),
};
