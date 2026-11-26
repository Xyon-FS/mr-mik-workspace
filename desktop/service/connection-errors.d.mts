export interface ConnectionIssue { category: string; message: string; details: string; retry: 'connection-only' | 'none' }
export function connectionIssue(error: unknown, options?: { localService?: boolean; offlineConfirmed?: boolean }): ConnectionIssue;
