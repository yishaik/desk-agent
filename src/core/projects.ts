import { join, resolve, sep, normalize } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { config } from './config.ts';

const RESERVED_PROJECT_IDS = new Set(['default', 'admin', 'api', 'system', '__proto__', 'proto', 'constructor', 'prototype']);

const MAX_PROJECT_ID_LENGTH = 40;

export class ProjectIdValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectIdValidationError';
  }
}

export function slugifyProjectName(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new ProjectIdValidationError('Project name is required');
  }

  const trimmed = name.trim();
  if (!trimmed) {
    throw new ProjectIdValidationError('Project name is required');
  }

  const slug = trimmed
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PROJECT_ID_LENGTH);

  if (!slug) {
    const hash = Buffer.from(trimmed).toString('base64url').slice(0, 8);
    return `p-${hash}`;
  }

  if (RESERVED_PROJECT_IDS.has(slug)) {
    throw new ProjectIdValidationError(`Project name "${name}" produces a reserved ID. Choose a different name.`);
  }

  return slug;
}

export function validateProjectId(projectId: string): string {
  if (!projectId || typeof projectId !== 'string') {
    throw new ProjectIdValidationError('Project ID is required');
  }

  if (projectId.includes('..') || projectId.includes('/') || projectId.includes('\\')) {
    throw new ProjectIdValidationError('Project ID contains invalid path characters');
  }

  if (projectId.includes('\0')) {
    throw new ProjectIdValidationError('Project ID contains null byte');
  }

  const normalizedId = projectId.toLowerCase().trim();
  
  if (normalizedId.length === 0 || normalizedId.length > MAX_PROJECT_ID_LENGTH) {
    throw new ProjectIdValidationError(`Project ID must be between 1 and ${MAX_PROJECT_ID_LENGTH} characters`);
  }

  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(normalizedId)) {
    throw new ProjectIdValidationError('Project ID must start and end with alphanumeric characters and contain only alphanumeric characters and hyphens');
  }

  if (RESERVED_PROJECT_IDS.has(normalizedId)) {
    throw new ProjectIdValidationError(`Project ID "${normalizedId}" is reserved`);
  }

  return normalizedId;
}

export function getProjectPath(projectId: string): string {
  const validId = validateProjectId(projectId);
  return join(config.dataDir, 'projects', validId);
}

export function assertPathInsideDataDir(targetPath: string, label = 'Path'): void {
  const dataDir = resolve(config.dataDir);
  const normalizedTarget = normalize(resolve(targetPath));
  
  if (!normalizedTarget.startsWith(dataDir + sep) && normalizedTarget !== dataDir) {
    throw new ProjectIdValidationError(`${label} escapes data directory`);
  }
  
  if (existsSync(normalizedTarget)) {
    try {
      const realTarget = realpathSync(normalizedTarget);
      if (!realTarget.startsWith(dataDir + sep) && realTarget !== dataDir) {
        throw new ProjectIdValidationError(`${label} resolves to a path outside data directory (symlink escape)`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}
