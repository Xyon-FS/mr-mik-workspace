export type SkillCompletion = { start: number; end: number; query: string };
export function skillCompletion(text: string, cursor: number, end?: number): SkillCompletion | null;
export function completeSkill(text: string, token: SkillCompletion, name: string, limit?: number): {text: string; cursor: number};
