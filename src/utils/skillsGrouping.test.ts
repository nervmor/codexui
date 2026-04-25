import { describe, expect, it } from 'vitest'

import { groupSkillsByNamePrefix } from './skillsGrouping'

describe('groupSkillsByNamePrefix', () => {
  it('groups colon-prefixed skills and keeps unprefixed skills in General', () => {
    const groups = groupSkillsByNamePrefix([
      { name: 'superpowers:brainstorming' },
      { name: 'openai-docs' },
      { name: 'superpowers:test-driven-development' },
      { name: 'npm-publish' },
    ])

    expect(groups).toEqual([
      {
        key: 'superpowers',
        label: 'Superpowers',
        skills: [
          { name: 'superpowers:brainstorming' },
          { name: 'superpowers:test-driven-development' },
        ],
      },
      {
        key: 'general',
        label: 'General',
        skills: [
          { name: 'openai-docs' },
          { name: 'npm-publish' },
        ],
      },
    ])
  })
})
