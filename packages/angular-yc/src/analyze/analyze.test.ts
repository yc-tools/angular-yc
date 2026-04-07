import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { Analyzer } from './index.js';

vi.mock('fs-extra');
vi.mock('glob', () => ({
  glob: vi.fn().mockResolvedValue([]),
}));

const compatCheckMock = vi.fn().mockReturnValue({
  compatible: true,
  warnings: [],
  errors: [],
});

vi.mock('../compat/index.js', () => ({
  CompatibilityChecker: vi.fn().mockImplementation(() => ({
    checkCapabilities: compatCheckMock,
  })),
}));

describe('Analyzer', () => {
  let analyzer: Analyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    compatCheckMock.mockReturnValue({ compatible: true, warnings: [], errors: [] });
    analyzer = new Analyzer();
  });

  it('detects Angular version from package.json', async () => {
    vi.mocked(fs.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readJson).mockResolvedValue({
      dependencies: { '@angular/core': '20.1.0' },
    });

    const version = await (analyzer as any).detectAngularVersion('/test/project');
    expect(version).toBe('20.1.0');
    expect(fs.readJson).toHaveBeenCalledWith(path.join('/test/project', 'package.json'));
  });

  it('normalizes Angular version with caret prefix', async () => {
    vi.mocked(fs.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readJson).mockResolvedValue({
      dependencies: { '@angular/core': '^21.0.2' },
    });

    const version = await (analyzer as any).detectAngularVersion('/test/project');
    expect(version).toBe('21.0.2');
  });

  it('throws when @angular/core is missing', async () => {
    vi.mocked(fs.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readJson).mockResolvedValue({ dependencies: {} });

    await expect((analyzer as any).detectAngularVersion('/test/project')).rejects.toThrow(
      '@angular/core not found in package.json dependencies',
    );
  });

  it('detects prerender routes from file', async () => {
    vi.mocked(fs.pathExists).mockImplementation(async (target) =>
      target.toString().endsWith('prerender-routes.txt'),
    );
    vi.mocked(fs.readFile).mockResolvedValue('/\n/about\n/products\n');

    const result = await (analyzer as any).detectPrerender('/test/project', {
      architect: {},
    });

    expect(result.enabled).toBe(true);
    expect(result.routes).toEqual(['/', '/about', '/products']);
    expect(result.discoveredFrom).toBe('routes-file');
  });

  it('detects express API routes from server entry', async () => {
    vi.mocked(fs.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(`
      import express from 'express';
      const app = express();
      app.get('/api/health', () => {});
      app.use('/api/admin', () => {});
    `);

    const result = await (analyzer as any).detectAPI('/test/project', 'server.ts');

    expect(result.enabled).toBe(true);
    expect(result.routesDetected).toContain('/api/health');
    expect(result.routesDetected).toContain('/api/admin');
  });

  it('detects pattern usage in source files', async () => {
    const { glob } = await import('glob');
    vi.mocked(glob).mockResolvedValue(['src/app/app.config.ts']);
    vi.mocked(fs.readFile).mockResolvedValue('provideClientHydration()');

    const result = await (analyzer as any).detectPatternUsage('/test/project', [
      'provideClientHydration(',
    ]);

    expect(result).toBe(true);
  });

  it('analyzes a complete Angular project', async () => {
    const { glob } = await import('glob');
    vi.mocked(glob).mockResolvedValue([]);

    vi.mocked(fs.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readJson).mockImplementation(async (target) => {
      const p = target.toString();
      if (p.endsWith('package.json')) {
        return {
          dependencies: {
            '@angular/core': '20.0.0',
            '@angular/ssr': '20.0.0',
          },
        };
      }

      if (p.endsWith('angular.json')) {
        return {
          defaultProject: 'app',
          projects: {
            app: {
              architect: {
                build: { options: { outputPath: 'dist/app/browser' } },
                server: { options: { outputPath: 'dist/app/server' } },
                prerender: { options: { routes: ['/'] } },
              },
            },
          },
        };
      }

      return {};
    });

    vi.mocked(fs.readFile).mockResolvedValue('');

    const capabilities = await analyzer.analyze({
      projectPath: '/test/project',
    });

    expect(capabilities.angularVersion).toBe('20.0.0');
    expect(capabilities).toHaveProperty('ssr');
    expect(capabilities).toHaveProperty('prerender');
    expect(capabilities).toHaveProperty('api');
    expect(capabilities).toHaveProperty('rendering');
    expect(capabilities).toHaveProperty('responseCache');
  });

  it('writes analysis artifacts when outputDir is provided', async () => {
    const { glob } = await import('glob');
    vi.mocked(glob).mockResolvedValue([]);

    vi.mocked(fs.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readJson).mockImplementation(async (target) => {
      const p = target.toString();
      if (p.endsWith('package.json')) {
        return {
          dependencies: {
            '@angular/core': '19.0.0',
            '@angular/ssr': '19.0.0',
          },
        };
      }
      return {
        defaultProject: 'app',
        projects: { app: { architect: {} } },
      };
    });

    vi.mocked(fs.readFile).mockResolvedValue('');

    await analyzer.analyze({
      projectPath: '/test/project',
      outputDir: '/test/output',
    });

    expect(fs.ensureDir).toHaveBeenCalledWith('/test/output');
    expect(fs.writeJson).toHaveBeenCalledWith(
      path.join('/test/output', 'capabilities.json'),
      expect.any(Object),
      { spaces: 2 },
    );
    expect(fs.writeJson).toHaveBeenCalledWith(
      path.join('/test/output', 'project.meta.json'),
      { projectName: 'app' },
      { spaces: 2 },
    );
  });

  it('throws when compatibility check fails', async () => {
    compatCheckMock.mockReturnValue({
      compatible: false,
      warnings: [],
      errors: ['Unsupported feature'],
    });

    vi.mocked(fs.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readJson).mockImplementation(async (target) => {
      const p = target.toString();
      if (p.endsWith('package.json')) {
        return {
          dependencies: {
            '@angular/core': '18.0.0',
            '@angular/ssr': '18.0.0',
          },
        };
      }
      return {
        defaultProject: 'app',
        projects: { app: { architect: {} } },
      };
    });
    vi.mocked(fs.readFile).mockResolvedValue('');

    await expect(analyzer.analyze({ projectPath: '/test/project' })).rejects.toThrow(
      'Project has incompatible features for YC Angular deployment',
    );
  });

  it('collects compatibility warnings into notes', async () => {
    compatCheckMock.mockReturnValue({
      compatible: true,
      warnings: ['Feature is experimental'],
      errors: [],
    });

    vi.mocked(fs.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readJson).mockImplementation(async (target) => {
      const p = target.toString();
      if (p.endsWith('package.json')) {
        return {
          dependencies: {
            '@angular/core': '19.0.0',
            '@angular/ssr': '19.0.0',
          },
        };
      }
      return {
        defaultProject: 'app',
        projects: { app: { architect: {} } },
      };
    });
    vi.mocked(fs.readFile).mockResolvedValue('');

    const capabilities = await analyzer.analyze({ projectPath: '/test/project' });

    expect(capabilities.notes).toContain('Feature is experimental');
  });
});
