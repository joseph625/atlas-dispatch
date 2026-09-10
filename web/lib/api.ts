import { getAccessToken } from './session';

const API_ROOT = process.env.API_BASE_URL ?? 'http://localhost:3333';
const API_BASE = `${API_ROOT}/api`; // app API lives under /api; webhooks are at root

export interface WorkItemSummary {
  id: string;
  vendor: string;
  status: 'pending' | 'done' | 'failed' | 'dead';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  eventId: string;
  eventType: string | null;
  receivedAt: string;
}

export interface Transition {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  attempt: number;
  note: string | null;
  createdAt: string;
}

export interface WorkItemDetail {
  id: string;
  vendor: string;
  status: WorkItemSummary['status'];
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  event: {
    id: string;
    vendor: string;
    vendorEventId: string;
    eventType: string | null;
    receivedAt: string;
    payload: unknown;
  };
  transitions: Transition[];
}

export interface Account {
  id: string;
  email: string;
  name: string;
  workspaces: { slug: string; name: string }[];
}

export interface Me {
  user: { id: string; email: string; name: string };
  permissions: string[];
  workspaces: { slug: string; name: string; role: string }[];
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// The API wraps every success in { statusCode, message, data, meta }. We unwrap
// `.data` here so callers see plain domain objects. All reads are server-side
// and forward the Bearer token; another tenant's data never reaches the client.
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new ApiError(res.status, `API ${res.status} for ${path}`);
  }
  const body = await res.json();
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
}

export { ApiError };

export async function login(
  email: string,
  password: string,
): Promise<{ accessToken: string; permissions: string[] }> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, 'login failed');
  const body = await res.json();
  return body.data;
}

export function getAccounts(): Promise<Account[]> {
  return apiFetch<Account[]>('/dev/accounts');
}

export function getMe(): Promise<Me> {
  return apiFetch<Me>('/me');
}

export function getWorkspace(slug: string): Promise<{ slug: string; name: string }> {
  return apiFetch(`/workspaces/${slug}`);
}

export function listWorkItems(
  slug: string,
  filters: { status?: string; vendor?: string },
): Promise<WorkItemSummary[]> {
  const qs = new URLSearchParams();
  if (filters.status) qs.set('status', filters.status);
  if (filters.vendor) qs.set('vendor', filters.vendor);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch<WorkItemSummary[]>(`/workspaces/${slug}/work-items${suffix}`);
}

export function getWorkItem(slug: string, id: string): Promise<WorkItemDetail> {
  return apiFetch<WorkItemDetail>(`/workspaces/${slug}/work-items/${id}`);
}

export function retryWorkItem(slug: string, id: string): Promise<{ id: string; status: string }> {
  return apiFetch(`/workspaces/${slug}/work-items/${id}/retry`, { method: 'POST' });
}
