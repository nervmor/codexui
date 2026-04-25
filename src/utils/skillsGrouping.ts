export type SkillGroupable = {
  name: string
}

export type SkillGroup<T extends SkillGroupable> = {
  key: string
  label: string
  skills: T[]
}

export function getSkillGroupKey(skillName: string): string {
  const prefix = skillName.split(':', 1)[0]?.trim()
  return prefix && prefix !== skillName ? prefix.toLowerCase() : 'general'
}

export function getSkillGroupLabel(groupKey: string): string {
  if (groupKey === 'general') return 'General'
  return groupKey
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

export function groupSkillsByNamePrefix<T extends SkillGroupable>(skills: T[]): SkillGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const skill of skills) {
    const key = getSkillGroupKey(skill.name)
    groups.set(key, [...(groups.get(key) ?? []), skill])
  }

  return [...groups.entries()]
    .map(([key, groupedSkills]) => ({
      key,
      label: getSkillGroupLabel(key),
      skills: groupedSkills,
    }))
    .sort((a, b) => {
      if (a.key === 'general') return 1
      if (b.key === 'general') return -1
      return a.label.localeCompare(b.label)
    })
}
