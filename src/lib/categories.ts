export const CATEGORY_ICONS: Record<string, string> = {
  'image-gen': '\u{1F3A8}',
  'analytics': '\u{1F4CA}',
  'research': '\u{1F50D}',
  'lead-magnet': '\u{1F9F2}',
  'game': '\u{1F3AE}',
  'dev': '\u{1F6E0}\u{FE0F}',
}

export const CARD_CATEGORIES = [
  { value: 'project', label: 'Project' },
  { value: 'dev', label: 'Development' },
  { value: 'research', label: 'Research' },
  { value: 'game', label: 'Game' },
  { value: 'image-gen', label: 'Visuals' },
  { value: 'analytics', label: 'Analytics' },
  { value: 'lead-magnet', label: 'Marketing' },
  { value: 'other', label: 'Other' },
] as const

export function categoryIcon(category: string): string {
  return CATEGORY_ICONS[category] ?? '\u{1F4C1}'
}
