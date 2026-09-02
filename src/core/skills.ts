import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Skill packs: one directory per pack under skills-pack/, each with a SKILL.md
 * (frontmatter name/description + instructions). The owner picks packs in
 * Settings (settings.skillPacks); both engines receive the same packs — Pi via
 * additionalSkillPaths, Claude Code via the system prompt (#74).
 */
export interface SkillPack {
  id: string;
  name: string;
  description: string;
  body: string;
  dir: string;
}

export const DEFAULT_SKILL_PACKS = ['inbox-calendar'];
export const SKILL_PACKS_ROOT = join(process.cwd(), 'skills-pack');

function parseSkillMd(raw: string): { name?: string; description?: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { name: meta['name'], description: meta['description'], body: match[2]!.trim() };
}

export function listSkillPacks(root: string = SKILL_PACKS_ROOT): SkillPack[] {
  if (!existsSync(root)) return [];
  const packs: SkillPack[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const skillPath = join(dir, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    const parsed = parseSkillMd(readFileSync(skillPath, 'utf8'));
    packs.push({
      id: entry.name,
      name: parsed.name ?? entry.name,
      description: parsed.description ?? '',
      body: parsed.body,
      dir,
    });
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id));
}

export function isKnownSkillPack(id: string, root: string = SKILL_PACKS_ROOT): boolean {
  return listSkillPacks(root).some((p) => p.id === id);
}

export function loadSkillPacks(ids: readonly string[] | undefined, root: string = SKILL_PACKS_ROOT): SkillPack[] {
  const wanted = new Set(ids ?? DEFAULT_SKILL_PACKS);
  return listSkillPacks(root).filter((p) => wanted.has(p.id));
}

/** Directories to hand to Pi's resource loader (each contains a SKILL.md). */
export function skillPackDirs(ids: readonly string[] | undefined, root: string = SKILL_PACKS_ROOT): string[] {
  return loadSkillPacks(ids, root).map((p) => p.dir);
}

/** Text appended to the Claude Code system prompt. Empty when no pack is selected. */
export function renderSkillsPrompt(ids: readonly string[] | undefined, root: string = SKILL_PACKS_ROOT): string {
  const packs = loadSkillPacks(ids, root);
  if (packs.length === 0) return '';
  const sections = packs.map((p) => `### ${p.name}\n${p.description ? p.description + '\n\n' : ''}${p.body}`);
  return ['## Skills', 'Follow these playbooks for the tasks they cover.', '', ...sections].join('\n');
}
