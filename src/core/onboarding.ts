import type { Project, Settings } from './types.ts';
import { createProject, getProject } from './memory.ts';
import { loadSettings, updateSettings } from './settings.ts';
import { ProjectIdValidationError, validateProjectId } from './projects.ts';

export const ONBOARDING_PROJECT_ID = 'workspace';

/**
 * Make sure the active project can be used by the agent runtime.
 *
 * Older installations used `default`, which is intentionally reserved by the
 * project validator. Migrate those installations to a real project before an
 * OAuth completion tries to recreate the model session.
 */
export function ensureUsableActiveProject(): Project {
  const settings = loadSettings();

  try {
    const activeId = validateProjectId(settings.activeProject);
    const existing = getProject(activeId);
    if (existing) return existing;

    return createProject({
      id: activeId,
      name: settings.businessName?.trim() || settings.ownerName?.trim() || activeId,
      description: 'Desk Agent workspace',
    });
  } catch (err) {
    if (!(err instanceof ProjectIdValidationError)) throw err;
  }

  const existingWorkspace = getProject(ONBOARDING_PROJECT_ID);
  const project = existingWorkspace ?? createProject({
    id: ONBOARDING_PROJECT_ID,
    name: settings.businessName?.trim() || settings.ownerName?.trim() || 'My workspace',
    description: 'Desk Agent workspace',
  });

  const projectTokens = { ...settings.projectTokens };
  if (!projectTokens[ONBOARDING_PROJECT_ID] && projectTokens['default']) {
    projectTokens[ONBOARDING_PROJECT_ID] = projectTokens['default'];
  }

  updateSettings({
    activeProject: ONBOARDING_PROJECT_ID,
    projectTokens,
  });

  return project;
}

export function getPublicSettingsUrl(): string {
  const domain = process.env['DOMAIN']?.trim();
  if (domain && domain !== 'localhost') return `https://${domain}/settings`;
  return 'http://localhost:3001/settings';
}

/** Internal prompt used to let the connected model start the WhatsApp setup. */
export function buildGuidedOnboardingPrompt(settings: Settings): string {
  return [
    '[Desk Agent guided onboarding handoff]',
    'Write the first onboarding message to the owner in Hebrew.',
    'Introduce yourself briefly and say you will configure the agent together, one question at a time.',
    'Ask only the first question now: how the owner would like to be addressed and what the business does.',
    'In later replies, help define the agent voice and boundaries, then explain how to connect Gmail/Google Calendar and other services through Open Connector.',
    `When settings need to be changed, direct the owner to ${getPublicSettingsUrl()}.`,
    'Never ask the owner to send passwords, OAuth codes, API keys, or admin tokens in WhatsApp.',
    `The active project is ${settings.activeProject}.`,
  ].join('\n');
}
