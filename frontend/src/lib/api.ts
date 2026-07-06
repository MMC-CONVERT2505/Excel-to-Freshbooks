import type { Issue } from '../data/entities';
import { getSessionId } from './session.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:1073';

export type ExcelDryRunReport = {
  entityId: string;
  name: string;
  file: string;
  savedAs?: string;
  total: number;
  columns: string[];
  issues: Issue[];
};

export type MigrationResult = {
  entity: string;
  total: number;
  success: number;
  skipped: number;
  failed: number;
  durationMs: number;
  errors: Array<{ row: number; error: string }>;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const sessionId = getSessionId();
  const merged: RequestInit = {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      ...(sessionId ? { 'X-Session-ID': sessionId } : {}),
    },
  };
  const res = await fetch(`${API_BASE}${path}`, merged);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      message = body?.message || body?.error || message;
    } catch {
      message = await res.text() || message;
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

export async function uploadExcelFile(entityId: string, file: File): Promise<ExcelDryRunReport> {
  return api<ExcelDryRunReport>(`/api/excel/upload/${entityId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      contentBase64: await fileToBase64(file),
    }),
  });
}

export async function dryRunExcel(ids: string[]): Promise<ExcelDryRunReport[]> {
  const body = await api<{ reports: ExcelDryRunReport[] }>('/api/excel/dry-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  return body.reports;
}

export function migrateExcelEntity(entityId: string): Promise<MigrationResult> {
  return api<MigrationResult>(`/migrate/${entityId}`, { method: 'POST' });
}

export function migrateExcelAll(): Promise<MigrationResult[]> {
  return api<MigrationResult[]>('/migrate/all', { method: 'POST' });
}

export type PhaseStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';

export type MigrationPhaseResult = {
  entity:      string;
  status:      PhaseStatus;
  total:       number;
  success:     number;
  skipped:     number;
  failed:      number;
  durationMs:  number;
  completedAt: string | null;
  startedAt:   string | null;
  errors:      Array<{ row: number; error: string }>;
};

export type MigrationStatusResponse = {
  run: {
    id:          number;
    status:      string;
    startedAt:   string | null;
    completedAt: string | null;
  } | null;
  phases: MigrationPhaseResult[];
};

export function getMigrationStatus(): Promise<MigrationStatusResponse> {
  return api<MigrationStatusResponse>('/migrate/status');
}

export function cancelMigration(entityId: string): Promise<{ cancelled: boolean }> {
  return api<{ cancelled: boolean }>(`/migrate/cancel/${entityId}`, { method: 'POST' });
}

export type CompanyEntry = {
  id:           number;
  accountId:    string | null;
  businessId:   string | null;
  companyLabel: string | null;
  isCurrent:    boolean;
  createdAt:    string;
};

export function getCompanies(): Promise<{ companies: CompanyEntry[] }> {
  return api<{ companies: CompanyEntry[] }>('/auth/companies');
}

export function switchCompany(tokenId: number): Promise<{ message: string }> {
  return api<{ message: string }>(`/auth/switch/${tokenId}`, { method: 'POST' });
}

export function updateCompanyLabel(tokenId: number, label: string): Promise<{ company: CompanyEntry }> {
  return api<{ company: CompanyEntry }>(`/auth/companies/${tokenId}/label`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
}

export type FBProject = {
  id:           number;
  title:        string;
  description:  string | null;
  project_type: string;
  client_id:    number | null;
  due_date:     string | null;
  budget:       number | null;
  fixed_price:  string | null;
  billed_amount: string | null;
  billed_status: string;
  active:       boolean;
  created_at:   string;
};

export function getProjects(): Promise<{ projects: FBProject[]; total: number }> {
  return api<{ projects: FBProject[]; total: number }>('/freshbooks/projects');
}

export function getEstimates(): Promise<{ response: { result: { estimates: any[]; total: number } } }> {
  return api('/freshbooks/estimates');
}

export function getEstimateLines(): Promise<{ lines: any[]; total: number }> {
  return api('/freshbooks/estimates/lines');
}

export function getCreditMemos(): Promise<{ response: { result: { credit_notes: any[]; total: number } } }> {
  return api('/freshbooks/credit-memos');
}

export type BulkOpResult = { deleted?: number; updated?: number; failed: number; errors: string[] };

export async function fbExportEntity(entity: string): Promise<void> {
  const sessionId = getSessionId();
  const res = await fetch(`${API_BASE}/freshbooks/export/${entity}`, {
    headers: sessionId ? { 'X-Session-ID': sessionId } : {},
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); message = b?.message || b?.error || message; } catch {}
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `freshbooks_${entity}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function fbDeleteById(entity: string, id: string): Promise<any> {
  return api(`/freshbooks/record/${entity}/${id}`, { method: 'DELETE' });
}

export function fbBulkDelete(entity: string): Promise<BulkOpResult> {
  return api<BulkOpResult>(`/freshbooks/record/bulk-delete/${entity}`, { method: 'POST' });
}

export function fbUpdateById(entity: string, id: string, body: Record<string, any>): Promise<any> {
  return api(`/freshbooks/record/${entity}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function fbBulkUpdate(entity: string): Promise<BulkOpResult> {
  return api<BulkOpResult>(`/freshbooks/record/bulk-update/${entity}`, { method: 'POST' });
}

export async function downloadErrorSheet(entityId: string): Promise<void> {
  const sessionId = getSessionId();
  const res = await fetch(`${API_BASE}/api/excel/errors/${entityId}`, {
    headers: sessionId ? { 'X-Session-ID': sessionId } : {},
  });
  if (!res.ok || res.status === 204) return;
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${entityId}-errors.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
