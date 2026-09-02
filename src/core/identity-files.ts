import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Settings } from './types.ts';
import { config } from './config.ts';
import { createChildLogger } from './logger.ts';

const log = createChildLogger('identity-files');

/**
 * Build the complete identity prompt text from settings.
 * This is the single source of truth for identity content that reaches the model.
 * Used by both Pi (AGENTS.md) and Claude Code (system prompt).
 */
export function buildIdentityPrompt(settings: Settings): string {
  const parts: string[] = [];

  parts.push(`You are ${settings.botName || 'Desk Agent'}, a personal WhatsApp assistant.`);

  if (settings.ownerName) {
    parts.push(`Your owner is ${settings.ownerName}.`);
  }

  if (settings.businessName) {
    parts.push(`You work for ${settings.businessName}.`);
  }

  if (settings.businessDescription) {
    parts.push('');
    parts.push('## About the Business');
    parts.push(settings.businessDescription);
  }

  if (settings.agentVoice) {
    parts.push('');
    parts.push('## Voice & Personality');
    parts.push(settings.agentVoice);
  }

  if (settings.agentBoundaries) {
    parts.push('');
    parts.push('## Boundaries');
    parts.push('You MUST follow these boundaries:');
    parts.push(settings.agentBoundaries);
  }

  parts.push('');
  parts.push('## Communication');
  parts.push(`- Timezone: ${settings.timezone || 'UTC'}`);
  parts.push('- Respond in the same language as the user message');
  parts.push('- Be concise and helpful');
  parts.push('- Ask for clarification when needed');

  return parts.join('\n');
}

export function generateSoulMd(settings: Settings): string {
  const parts: string[] = [];
  
  parts.push(`# ${settings.botName || 'Desk Agent'}`);
  parts.push('');
  
  if (settings.businessName) {
    parts.push(`Personal AI assistant for **${settings.businessName}**.`);
  } else {
    parts.push('Personal AI assistant.');
  }
  parts.push('');
  
  if (settings.ownerName) {
    parts.push('## Owner');
    parts.push(settings.ownerName);
    parts.push('');
  }
  
  if (settings.businessDescription) {
    parts.push('## About the Business');
    parts.push(settings.businessDescription);
    parts.push('');
  }
  
  if (settings.agentVoice) {
    parts.push('## Voice & Personality');
    parts.push(settings.agentVoice);
    parts.push('');
  }
  
  if (settings.agentBoundaries) {
    parts.push('## Boundaries');
    parts.push(settings.agentBoundaries);
    parts.push('');
  }
  
  parts.push('## Timezone');
  parts.push(settings.timezone || 'UTC');
  parts.push('');
  
  parts.push('## Communication');
  parts.push('- Respond in the same language as the user message');
  parts.push('- Be concise and helpful');
  parts.push('- Ask for clarification when needed');
  parts.push('');
  
  return parts.join('\n');
}

/**
 * Generate AGENTS.md content for a specific project.
 * 
 * @param settings - Current settings (for identity content)
 * @param projectId - The project ID to use in the header. Defaults to settings.activeProject.
 */
export function generateAgentsMdForProject(settings: Settings, projectId?: string): string {
  const targetProject = projectId ?? settings.activeProject;
  const parts: string[] = [];
  
  parts.push(`# ${targetProject}`);
  parts.push('');

  parts.push(buildIdentityPrompt(settings));
  parts.push('');
  
  parts.push('## Open Connector');
  parts.push('Use the oc_* tools to interact with connected services:');
  parts.push('- oc_search_actions: Find available actions');
  parts.push('- oc_get_action_guide: Get action documentation');
  parts.push('- oc_execute_action: Execute (requires user confirmation for mutating actions)');
  parts.push('- oc_list_connections: List connected services');
  parts.push('');
  parts.push('For send/create/update/delete actions, always wait for the user to confirm before executing.');
  parts.push('');
  
  return parts.join('\n');
}

/**
 * Generate AGENTS.md content for the active project.
 * @deprecated Use generateAgentsMdForProject for explicit project targeting.
 */
export function generateAgentsMd(settings: Settings): string {
  return generateAgentsMdForProject(settings, settings.activeProject);
}

/**
 * Write identity files (SOUL.md and AGENTS.md) to a project directory.
 * 
 * @param settings - Current settings
 * @param projectId - Optional project ID to write to. Defaults to settings.activeProject.
 *                    Use this when creating a session for a non-active project.
 */
export function writeIdentityFiles(settings: Settings, projectId?: string): void {
  const targetProject = projectId ?? settings.activeProject;
  const projectDir = join(config.dataDir, 'projects', targetProject);
  
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }
  
  const soulMdPath = join(projectDir, 'SOUL.md');
  const agentsMdPath = join(projectDir, 'AGENTS.md');
  
  const soulContent = generateSoulMd(settings);
  const agentsContent = generateAgentsMdForProject(settings, targetProject);
  
  writeFileSync(soulMdPath, soulContent, 'utf-8');
  log.info({ path: soulMdPath, projectId: targetProject }, 'Wrote SOUL.md');
  
  writeFileSync(agentsMdPath, agentsContent, 'utf-8');
  log.info({ path: agentsMdPath, projectId: targetProject }, 'Wrote AGENTS.md');
}
