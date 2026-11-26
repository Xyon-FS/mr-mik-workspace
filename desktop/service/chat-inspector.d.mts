export type DiffRow = { type: string; text: string; old: number | null; next: number | null }
export type RecordedPatch = { id: string; previousPath: string | null; kind: string; rows: DiffRow[]; truncated: boolean; binary: boolean }
export type InspectedChange = { id: string; key: string; path: string; displayPath: string; patches: RecordedPatch[]; added: number; removed: number }
export type Inspection = { sessionId: string; itemId: string; runtimeId: string; version: string; type: string; status: string; review: string; reviewTruncated: boolean; reviewSummary: string; structuredReview: boolean; filesTruncated: boolean; files: InspectedChange[]; findings: { id: string; title: string; body: string; priority: number | null; path: string; line: number | null; end: number | null; source: string; fileId: string | null }[] }
export type InspectedFile = { status: string; message?: string; path?: string; line?: number; start?: number; totalLines?: number; partial?: boolean; modifiedAt?: string; lines?: { number: number; text: string; truncated: boolean }[] }
export function diffRows(diff: string): DiffRow[]
export function inspectItem(runtime: unknown, itemId: string): Inspection
export function inspectFile(runtime: unknown, request: unknown): Promise<InspectedFile>

export function quoteRecordedDiff(runtime: unknown, request: unknown): {added: boolean; submitted: boolean};
