import { createChildLogger } from '../core/logger.ts';
import type { Settings } from '../core/types.ts';

const log = createChildLogger('apply-settings');

export async function applySavedSettings(
  settings: Settings,
  changedFields: string[]
): Promise<void> {
  const { clearSession, getOrCreateSession, setSessionModel } = await import('../agent/session.ts');
  
  const modelChanged = changedFields.includes('model');
  const identityChanged = changedFields.some(field => 
    ['ownerName', 'businessName', 'businessDescription', 'botName', 'agentVoice', 'agentBoundaries', 'timezone'].includes(field)
  );
  
  if (modelChanged && settings.model) {
    log.info({ model: settings.model, project: settings.activeProject }, 'Applying model change');
    await setSessionModel(settings.activeProject, settings.model);
    return;
  }
  
  if (identityChanged) {
    log.info({ project: settings.activeProject, changedFields }, 'Applying identity change');
    clearSession(settings.activeProject);
    await getOrCreateSession(settings.activeProject);
    return;
  }
  
  log.debug({ changedFields }, 'No session-affecting changes');
}

export function detectChangedFields(
  oldSettings: Partial<Settings>,
  newSettings: Partial<Settings>
): string[] {
  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(oldSettings), ...Object.keys(newSettings)]);
  
  for (const key of allKeys) {
    const oldVal = oldSettings[key as keyof Settings];
    const newVal = newSettings[key as keyof Settings];
    if (oldVal !== newVal) {
      changed.push(key);
    }
  }
  
  return changed;
}
