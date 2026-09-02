import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSkillPacks, loadSkillPacks, renderSkillsPrompt, skillPackDirs, isKnownSkillPack, DEFAULT_SKILL_PACKS } from './skills.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'skills-'));
  mkdirSync(join(root, 'alpha'));
  writeFileSync(join(root, 'alpha', 'SKILL.md'), '---\nname: Alpha Pack\ndescription: does alpha things\n---\n\n# Alpha\nUse alpha.');
  mkdirSync(join(root, 'beta'));
  writeFileSync(join(root, 'beta', 'SKILL.md'), '# Beta\nNo frontmatter here.');
  mkdirSync(join(root, 'not-a-pack'));
  writeFileSync(join(root, 'stray.json'), '{}');
  return root;
}

describe('skill packs (#74)', () => {
  it('lists only directories with a SKILL.md, parsing frontmatter when present', () => {
    const root = fixture();
    try {
      const packs = listSkillPacks(root);
      expect(packs.map((p) => p.id)).toEqual(['alpha', 'beta']);
      expect(packs[0]).toMatchObject({ name: 'Alpha Pack', description: 'does alpha things' });
      expect(packs[0]!.body).toBe('# Alpha\nUse alpha.');
      expect(packs[1]).toMatchObject({ name: 'beta', description: '' });
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('loads only the selected packs and ignores unknown ids', () => {
    const root = fixture();
    try {
      expect(loadSkillPacks(['beta', 'ghost'], root).map((p) => p.id)).toEqual(['beta']);
      expect(skillPackDirs(['alpha'], root)).toEqual([join(root, 'alpha')]);
      expect(isKnownSkillPack('alpha', root)).toBe(true);
      expect(isKnownSkillPack('ghost', root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('renders a system-prompt section for the selected packs only', () => {
    const root = fixture();
    try {
      const text = renderSkillsPrompt(['alpha'], root);
      expect(text).toContain('## Skills');
      expect(text).toContain('### Alpha Pack');
      expect(text).toContain('Use alpha.');
      expect(text).not.toContain('Beta');
      expect(renderSkillsPrompt([], root)).toBe('');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('ships the real packs and a sane default', () => {
    const ids = listSkillPacks().map((p) => p.id);
    expect(ids).toEqual(['inbox-calendar', 'light-crm', 'storefront-faq']);
    expect(DEFAULT_SKILL_PACKS.every((id) => ids.includes(id))).toBe(true);
  });
});
