import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import archiver from 'archiver';
import { Builder } from './index.js';

vi.mock('fs-extra');
vi.mock('archiver');
vi.mock('../analyze/index.js');
vi.mock('../compat/index.js');
vi.mock('esbuild', () => ({
  build: vi.fn().mockResolvedValue({}),
}));
vi.mock('chalk', () => ({
  default: {
    blue: (s: string) => s,
    gray: (s: string) => s,
    cyan: (s: string) => s,
    yellow: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
  },
}));
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  })),
}));

describe('Builder', () => {
  let builder: Builder;
  const mockProjectPath = '/test/project';
  const mockOutputPath = '/test/output';

  beforeEach(() => {
    builder = new Builder();
    vi.clearAllMocks();

    vi.mocked(fs.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readJson).mockImplementation(async (target) => {
      const p = target.toString();
      if (p.endsWith('angular.json')) {
        return {
          defaultProject: 'app',
          projects: {
            app: {
              architect: {
                build: { options: { outputPath: 'dist/app/browser' } },
                server: { options: { outputPath: 'dist/app/server' } },
              },
            },
          },
        };
      }

      if (p.includes('@angular-yc/runtime') || p.includes('runtime-yc/package.json')) {
        return {
          dependencies: {},
        };
      }

      return {
        scripts: {
          build: 'ng build',
        },
        dependencies: {
          express: '^4.0.0',
        },
      };
    });

    vi.mocked(fs.readFile).mockResolvedValue('build-id');
    vi.mocked(fs.ensureDir).mockResolvedValue();
    vi.mocked(fs.copy).mockResolvedValue();
    vi.mocked(fs.writeFile).mockResolvedValue();
    vi.mocked(fs.writeJson).mockResolvedValue();
    vi.mocked(fs.remove).mockResolvedValue();

    const mockStream = {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'close') {
          setTimeout(cb, 0);
        }
        return mockStream;
      }),
    };
    vi.mocked(fs.createWriteStream).mockReturnValue(mockStream as any);

    const mockArchive = {
      pipe: vi.fn(),
      directory: vi.fn(),
      finalize: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
    vi.mocked(archiver).mockReturnValue(mockArchive as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds Angular project with server and image artifacts', async () => {
    const mockCapabilities = {
      angularVersion: '20.0.0',
      ssr: { enabled: true, expressAdapter: 'express-app', standaloneBundle: true },
      prerender: { enabled: true, routes: ['/'], discoveredFrom: 'angular-json' },
      api: { enabled: true, framework: 'express', basePath: '/api', routesDetected: ['/api'] },
      rendering: {
        needsServer: true,
        lazyLoading: true,
        standalone: true,
        hydration: { enabled: true, incremental: false },
        signals: { enabled: true, linkedSignal: false, resourceApi: false },
        zoneless: { enabled: false, stable: false },
      },
      assets: { needsImage: true, ngOptimizedImage: true },
      responseCache: {
        enabled: true,
        defaultTtlSeconds: 60,
        staleWhileRevalidateSeconds: 30,
        varyHeaders: ['accept-language'],
        bypassPaths: ['/api/*'],
        purgePath: '/api/__cache/purge',
        tagsEnabled: true,
      },
      notes: [],
    };

    const { Analyzer } = await import('../analyze/index.js');
    vi.mocked(Analyzer.prototype.analyze).mockResolvedValue(mockCapabilities as any);

    await builder.build({
      projectPath: mockProjectPath,
      outputDir: mockOutputPath,
      skipBuild: true,
    });

    expect(Analyzer.prototype.analyze).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('_entry.mjs'),
      expect.stringContaining('createServerHandler'),
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('_entry.mjs'),
      expect.stringContaining('createImageHandler'),
    );
    expect(fs.writeJson).toHaveBeenCalledWith(
      expect.stringContaining('openapi-template.json'),
      expect.any(Object),
      expect.any(Object),
    );
    expect(fs.writeJson).toHaveBeenCalledWith(
      expect.stringContaining('deploy.manifest.json'),
      expect.objectContaining({
        schemaVersion: '1.0',
        angularVersion: '20.0.0',
      }),
      expect.any(Object),
    );
  });

  it('skips image package when needsImage is false', async () => {
    const mockCapabilities = {
      angularVersion: '20.0.0',
      ssr: { enabled: true, expressAdapter: 'express-app', standaloneBundle: true },
      prerender: { enabled: false, routes: [], discoveredFrom: 'none' },
      api: { enabled: true, framework: 'express', basePath: '/api', routesDetected: ['/api'] },
      rendering: {
        needsServer: true,
        lazyLoading: false,
        standalone: true,
        hydration: { enabled: false, incremental: false },
        signals: { enabled: false, linkedSignal: false, resourceApi: false },
        zoneless: { enabled: false, stable: false },
      },
      assets: { needsImage: false, ngOptimizedImage: false },
      responseCache: {
        enabled: true,
        defaultTtlSeconds: 60,
        staleWhileRevalidateSeconds: 30,
        varyHeaders: [],
        bypassPaths: ['/api/*'],
        purgePath: '/api/__cache/purge',
        tagsEnabled: false,
      },
      notes: [],
    };

    const { Analyzer } = await import('../analyze/index.js');
    vi.mocked(Analyzer.prototype.analyze).mockResolvedValue(mockCapabilities as any);

    await builder.build({ projectPath: mockProjectPath, outputDir: mockOutputPath, skipBuild: true });

    const imageWrites = vi
      .mocked(fs.writeFile)
      .mock.calls.filter((call) => call[1].toString().includes('createImageHandler'));
    expect(imageWrites).toHaveLength(0);
  });

  it('skips server package when needsServer is false', async () => {
    const mockCapabilities = {
      angularVersion: '20.0.0',
      ssr: { enabled: false, expressAdapter: 'none', standaloneBundle: false },
      prerender: { enabled: true, routes: ['/'], discoveredFrom: 'angular-json' },
      api: { enabled: false, framework: 'express', basePath: '/api', routesDetected: [] },
      rendering: {
        needsServer: false,
        lazyLoading: false,
        standalone: true,
        hydration: { enabled: false, incremental: false },
        signals: { enabled: false, linkedSignal: false, resourceApi: false },
        zoneless: { enabled: false, stable: false },
      },
      assets: { needsImage: false, ngOptimizedImage: false },
      responseCache: {
        enabled: false,
        defaultTtlSeconds: 60,
        staleWhileRevalidateSeconds: 30,
        varyHeaders: [],
        bypassPaths: ['/api/*'],
        purgePath: '/api/__cache/purge',
        tagsEnabled: false,
      },
      notes: [],
    };

    const { Analyzer } = await import('../analyze/index.js');
    vi.mocked(Analyzer.prototype.analyze).mockResolvedValue(mockCapabilities as any);

    await builder.build({ projectPath: mockProjectPath, outputDir: mockOutputPath, skipBuild: true });

    const serverWrites = vi
      .mocked(fs.writeFile)
      .mock.calls.filter((call) => call[1].toString().includes('createServerHandler'));
    expect(serverWrites).toHaveLength(0);
  });

  it('propagates analysis errors', async () => {
    const { Analyzer } = await import('../analyze/index.js');
    vi.mocked(Analyzer.prototype.analyze).mockRejectedValue(new Error('Analysis failed'));

    await expect(
      builder.build({ projectPath: mockProjectPath, outputDir: mockOutputPath, skipBuild: true }),
    ).rejects.toThrow('Analysis failed');
  });

  it('bundles server handler with esbuild', async () => {
    const mockCapabilities = {
      angularVersion: '20.0.0',
      ssr: { enabled: true, expressAdapter: 'express-app', standaloneBundle: true },
      prerender: { enabled: false, routes: [], discoveredFrom: 'none' },
      api: { enabled: true, framework: 'express', basePath: '/api', routesDetected: ['/api'] },
      rendering: {
        needsServer: true,
        lazyLoading: false,
        standalone: true,
        hydration: { enabled: false, incremental: false },
        signals: { enabled: false, linkedSignal: false, resourceApi: false },
        zoneless: { enabled: false, stable: false },
      },
      assets: { needsImage: false, ngOptimizedImage: false },
      responseCache: {
        enabled: true,
        defaultTtlSeconds: 60,
        staleWhileRevalidateSeconds: 30,
        varyHeaders: [],
        bypassPaths: ['/api/*'],
        purgePath: '/api/__cache/purge',
        tagsEnabled: false,
      },
      notes: [],
    };

    const { Analyzer } = await import('../analyze/index.js');
    vi.mocked(Analyzer.prototype.analyze).mockResolvedValue(mockCapabilities as any);

    await builder.build({ projectPath: mockProjectPath, outputDir: mockOutputPath, skipBuild: true });

    const esbuild = await import('esbuild');
    expect(esbuild.build).toHaveBeenCalledWith(
      expect.objectContaining({
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['sharp', '@img/*'],
      }),
    );
  });

  it('generates Angular OpenAPI routes', async () => {
    const mockCapabilities = {
      angularVersion: '20.0.0',
      ssr: { enabled: true, expressAdapter: 'express-app', standaloneBundle: true },
      prerender: { enabled: false, routes: [], discoveredFrom: 'none' },
      api: { enabled: true, framework: 'express', basePath: '/api', routesDetected: ['/api'] },
      rendering: {
        needsServer: true,
        lazyLoading: false,
        standalone: true,
        hydration: { enabled: false, incremental: false },
        signals: { enabled: false, linkedSignal: false, resourceApi: false },
        zoneless: { enabled: false, stable: false },
      },
      assets: { needsImage: true, ngOptimizedImage: true },
      responseCache: {
        enabled: true,
        defaultTtlSeconds: 60,
        staleWhileRevalidateSeconds: 30,
        varyHeaders: [],
        bypassPaths: ['/api/*'],
        purgePath: '/api/__cache/purge',
        tagsEnabled: false,
      },
      notes: [],
    };

    const { Analyzer } = await import('../analyze/index.js');
    vi.mocked(Analyzer.prototype.analyze).mockResolvedValue(mockCapabilities as any);

    await builder.build({ projectPath: mockProjectPath, outputDir: mockOutputPath, skipBuild: true });

    const openApiCall = vi
      .mocked(fs.writeJson)
      .mock.calls.find((call) => call[0].toString().includes('openapi-template.json'));

    const spec = openApiCall?.[1] as any;
    expect(spec.paths['/browser/{proxy+}']).toBeDefined();
    expect(spec.paths['/assets/{proxy+}']).toBeDefined();
    expect(spec.paths['/_image']).toBeDefined();
    expect(spec.paths['/api/{proxy+}']).toBeDefined();
    expect(spec.paths['/{proxy+}']).toBeDefined();
  });

  it('creates deployment manifest with angular metadata', async () => {
    const mockCapabilities = {
      angularVersion: '21.0.0',
      ssr: { enabled: true, expressAdapter: 'express-app', standaloneBundle: true },
      prerender: { enabled: true, routes: ['/'], discoveredFrom: 'angular-json' },
      api: { enabled: true, framework: 'express', basePath: '/api', routesDetected: ['/api'] },
      rendering: {
        needsServer: true,
        lazyLoading: true,
        standalone: true,
        hydration: { enabled: true, incremental: true },
        signals: { enabled: true, linkedSignal: true, resourceApi: true },
        zoneless: { enabled: true, stable: true },
      },
      assets: { needsImage: true, ngOptimizedImage: true },
      responseCache: {
        enabled: true,
        defaultTtlSeconds: 120,
        staleWhileRevalidateSeconds: 60,
        varyHeaders: ['accept-language'],
        bypassPaths: ['/api/*'],
        purgePath: '/api/__cache/purge',
        tagsEnabled: true,
      },
      notes: [],
    };

    const { Analyzer } = await import('../analyze/index.js');
    vi.mocked(Analyzer.prototype.analyze).mockResolvedValue(mockCapabilities as any);

    await builder.build({ projectPath: mockProjectPath, outputDir: mockOutputPath, skipBuild: true });

    const manifestCall = vi
      .mocked(fs.writeJson)
      .mock.calls.find((call) => call[0].toString().includes('deploy.manifest.json'));

    const manifest = manifestCall?.[1] as any;

    expect(manifest.schemaVersion).toBe('1.0');
    expect(manifest.angularVersion).toBe('21.0.0');
    expect(manifest.projectName).toBe('app');
    expect(manifest.capabilities.responseCache.enabled).toBe(true);
  });

  it('fails when browser output is missing', async () => {
    const mockCapabilities = {
      angularVersion: '20.0.0',
      ssr: { enabled: false, expressAdapter: 'none', standaloneBundle: false },
      prerender: { enabled: false, routes: [], discoveredFrom: 'none' },
      api: { enabled: false, framework: 'express', basePath: '/api', routesDetected: [] },
      rendering: {
        needsServer: false,
        lazyLoading: false,
        standalone: false,
        hydration: { enabled: false, incremental: false },
        signals: { enabled: false, linkedSignal: false, resourceApi: false },
        zoneless: { enabled: false, stable: false },
      },
      assets: { needsImage: false, ngOptimizedImage: false },
      responseCache: {
        enabled: false,
        defaultTtlSeconds: 60,
        staleWhileRevalidateSeconds: 30,
        varyHeaders: [],
        bypassPaths: ['/api/*'],
        purgePath: '/api/__cache/purge',
        tagsEnabled: false,
      },
      notes: [],
    };

    const { Analyzer } = await import('../analyze/index.js');
    vi.mocked(Analyzer.prototype.analyze).mockResolvedValue(mockCapabilities as any);

    vi.mocked(fs.pathExists).mockImplementation(async (target) => {
      const p = target.toString();
      if (p.endsWith('dist/app/browser')) {
        return false;
      }
      return true;
    });

    await expect(
      builder.build({ projectPath: mockProjectPath, outputDir: mockOutputPath, skipBuild: true }),
    ).rejects.toThrow('Browser output directory not found');
  });
});
