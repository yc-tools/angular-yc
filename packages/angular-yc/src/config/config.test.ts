import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  firstDefined,
  getConfigBoolean,
  getConfigRecord,
  getConfigString,
  getEnvBoolean,
  getEnvString,
  loadAngularYcConfig,
  parseBoolean,
  readFunctionResources,
} from './index.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'angular-yc-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await fs.remove(dir);
  }
});

describe('loadAngularYcConfig', () => {
  it('loads JSON config by default name', async () => {
    const dir = await createTempDir();
    await fs.writeJson(path.join(dir, 'angular-yc-cfg.json'), { project: '.', output: './build' });

    const loaded = await loadAngularYcConfig({ cwd: dir });
    expect(loaded.path).toContain('angular-yc-cfg.json');
    expect(loaded.data.project).toBe('.');
  });

  it('loads YAML config by explicit path', async () => {
    const dir = await createTempDir();
    const configPath = path.join(dir, 'custom.yml');
    await fs.writeFile(configPath, 'project: .\noutput: ./build\n');

    const loaded = await loadAngularYcConfig({ cwd: dir, configPath: './custom.yml' });
    expect(loaded.path).toBe(configPath);
    expect(loaded.data.output).toBe('./build');
  });

  it('returns empty config when no file exists', async () => {
    const dir = await createTempDir();
    const loaded = await loadAngularYcConfig({ cwd: dir });
    expect(loaded.path).toBeUndefined();
    expect(loaded.data).toEqual({});
  });
});

describe('config getters', () => {
  it('reads typed values', () => {
    const config = {
      project: '.',
      enabled: true,
      nested: { key: 'value' },
    };

    expect(getConfigString(config, 'project')).toBe('.');
    expect(getConfigBoolean(config, 'enabled')).toBe(true);
    expect(getConfigRecord(config, 'nested')).toEqual({ key: 'value' });
  });
});

describe('env getters and helpers', () => {
  it('reads env values and booleans', () => {
    const env = {
      AYC_PROJECT: '.',
      AYC_AUTO_APPROVE: 'true',
    };

    expect(getEnvString(env, 'AYC_PROJECT')).toBe('.');
    expect(getEnvBoolean(env, 'AYC_AUTO_APPROVE')).toBe(true);
  });

  it('parses booleans and first defined values', () => {
    expect(parseBoolean('yes')).toBe(true);
    expect(parseBoolean('0')).toBe(false);
    expect(parseBoolean('unknown')).toBeUndefined();
    expect(firstDefined(undefined, 'x', 'y')).toBe('x');
  });
});

/**
 * The manifest schema has always described these and terraform has always
 * honoured them, but build regenerates the manifest from hardcoded defaults on
 * every deploy — so before this, a project could not set them at all. The
 * default timeout of 30 seconds is fine for rendering a page and far too short
 * for a route that calls a language model.
 */
describe('readFunctionResources', () => {
  const withDeployment = (server: Record<string, unknown>) => ({
    deployment: { functions: { server } },
  });

  it('returns nothing when the config says nothing', () => {
    expect(readFunctionResources({}, 'server')).toBeUndefined();
    expect(readFunctionResources({ deployment: {} }, 'server')).toBeUndefined();
    expect(readFunctionResources({ deployment: { functions: {} } }, 'server')).toBeUndefined();
  });

  it('reads the settings a project asked for', () => {
    expect(readFunctionResources(withDeployment({ timeout: 300, memory: 1024 }), 'server')).toEqual({
      timeout: 300,
      memory: 1024,
    });
  });

  it('reads only the keys that were given, so the rest keep their defaults', () => {
    expect(readFunctionResources(withDeployment({ timeout: 120 }), 'server')).toEqual({ timeout: 120 });
  });

  it('keeps server and image apart', () => {
    const config = { deployment: { functions: { server: { timeout: 300 }, image: { memory: 512 } } } };
    expect(readFunctionResources(config, 'server')).toEqual({ timeout: 300 });
    expect(readFunctionResources(config, 'image')).toEqual({ memory: 512 });
  });

  it('accepts preparedInstances of zero rather than reading it as absent', () => {
    expect(readFunctionResources(withDeployment({ preparedInstances: 0 }), 'server')).toEqual({
      preparedInstances: 0,
    });
  });

  it('accepts a number written as a string, since YAML and env vars produce those', () => {
    expect(readFunctionResources(withDeployment({ timeout: '300' }), 'server')).toEqual({ timeout: 300 });
  });

  it('refuses a timeout Cloud Functions would reject', () => {
    expect(() => readFunctionResources(withDeployment({ timeout: 0 }), 'server')).toThrow(/between 1 and 3600/);
    expect(() => readFunctionResources(withDeployment({ timeout: 4000 }), 'server')).toThrow(/between 1 and 3600/);
  });

  it('refuses values that are not whole non-negative numbers', () => {
    expect(() => readFunctionResources(withDeployment({ memory: -1 }), 'server')).toThrow(/non-negative integer/);
    expect(() => readFunctionResources(withDeployment({ memory: 1.5 }), 'server')).toThrow(/non-negative integer/);
    expect(() => readFunctionResources(withDeployment({ timeout: 'soon' }), 'server')).toThrow(/non-negative integer/);
  });
});
