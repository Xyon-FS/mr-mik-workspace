export function skillMentions(text: string): { name: string; start: number; end: number }[];
export function mentionedSkills<T extends { name: string; path: string }>(text: string, available: T[]): T[];
export function withoutLeadingSkillMention(text: string, names: string[]): string;
