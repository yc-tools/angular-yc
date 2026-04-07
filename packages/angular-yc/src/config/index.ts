import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';

export interface LoadedAngularYcConfig {
  path?: string;
  data: Record<string, unknown>;
}

const DEFAULT_CONFIG_NAMES = [
  'angular-yc-cfg.json',
  '.angular-yc-cfg',
  'angular-yc-cfg.yml',
  'angular-yc-cfg.yaml',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfigContent(content: string, filePath: string): Record<string, unknown> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json') {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Config must be an object: ${filePath}`);
    }
    return parsed;
  }

  if (ext === '.yml' || ext === '.yaml') {
    const parsed = yaml.load(content) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Config must be an object: ${filePath}`);
    }
    return parsed;
  }

  try {
    const parsedJson = JSON.parse(content) as unknown;
    if (isRecord(parsedJson)) {
      return parsedJson;
    }
  } catch {
    // Fall through and try YAML.
  }

  const parsedYaml = yaml.load(content) as unknown;
  if (!isRecord(parsedYaml)) {
    throw new Error(`Config must be an object: ${filePath}`);
  }
  return parsedYaml;
}

export async function loadAngularYcConfig(options: {
  configPath?: string;
  projectPath?: string;
  cwd?: string;
}): Promise<LoadedAngularYcConfig> {
  const cwd = path.resolve(options.cwd || process.cwd());

  if (options.configPath) {
    const absolute = path.resolve(cwd, options.configPath);
    if (!(await fs.pathExists(absolute))) {
      throw new Error(`Config file not found: ${absolute}`);
    }

    const content = await fs.readFile(absolute, 'utf8');
    return {
      path: absolute,
      data: parseConfigContent(content, absolute),
    };
  }

  const projectPath = options.projectPath ? path.resolve(options.projectPath) : undefined;
  const candidateDirs = [cwd, projectPath].filter((value, idx, arr): value is string => {
    return Boolean(value) && arr.indexOf(value) === idx;
  });

  for (const dir of candidateDirs) {
    for (const name of DEFAULT_CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (await fs.pathExists(candidate)) {
        const content = await fs.readFile(candidate, 'utf8');
        return {
          path: candidate,
          data: parseConfigContent(content, candidate),
        };
      }
    }
  }

  return { data: {} };
}

export function getConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function getConfigBoolean(
  config: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = config[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return parseBoolean(value);
  }
  return undefined;
}

export function getConfigRecord(
  config: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = config[key];
  return isRecord(value) ? value : undefined;
}

export function getEnvString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function getEnvBoolean(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  return parseBoolean(env[key]);
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
