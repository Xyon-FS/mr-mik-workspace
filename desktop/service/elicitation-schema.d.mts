export type ElicitationField = { name: string; title: string; description: string; type: string; required: boolean; options: { value: string; label: string }[] | null; rule: Record<string, unknown> }
export function elicitationFields(schema: unknown): { fields: ElicitationField[]; error: string }
export function validateElicitation(schema: unknown, content: unknown): { valid: boolean; errors: Record<string, string>; error: string }
