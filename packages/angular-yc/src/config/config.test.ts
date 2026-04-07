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
