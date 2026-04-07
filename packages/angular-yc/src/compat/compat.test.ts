import { describe, it, expect } from 'vitest';
import { CompatibilityChecker } from './index.js';
import type { AnalyzeCapabilities } from '../analyze/index.js';

describe('CompatibilityChecker', () => {
  const checker = new CompatibilityChecker();

  const baseCapabilities = (version: string): AnalyzeCapabilities => ({
    angularVersion: version,
    ssr: {
      enabled: true,
      expressAdapter: 'express-app',
      standaloneBundle: true,
    },
    prerender: {
      enabled: true,
      routes: ['/'],
      discoveredFrom: 'angular-json',
    },
    api: {
      enabled: true,
      framework: 'express',
      basePath: '/api',
      routesDetected: ['/api/health'],
    },
    rendering: {
      needsServer: true,
      lazyLoading: true,
      standalone: true,
      hydration: {
        enabled: true,
        incremental: true,
      },
      signals: {
        enabled: true,
        linkedSignal: true,
        resourceApi: true,
      },
      zoneless: {
        enabled: true,
        stable: true,
      },
    },
    assets: {
      needsImage: true,
      ngOptimizedImage: true,
    },
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
  });

  describe('checkCompatibility', () => {
    it('passes for fully supported Angular 20 configuration', () => {
      const result = checker.checkCompatibility(baseCapabilities('20.0.0'));
      expect(result.compatible).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes for Angular 18 with conservative features', () => {
      const capabilities = baseCapabilities('18.2.0');
      capabilities.rendering.hydration.incremental = false;
      capabilities.rendering.signals.linkedSignal = false;
      capabilities.rendering.zoneless.enabled = false;
      capabilities.rendering.zoneless.stable = false;

      const result = checker.checkCompatibility(capabilities);
      expect(result.compatible).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes for Angular 19 with incremental hydration', () => {
      const capabilities = baseCapabilities('19.1.0');
      capabilities.rendering.zoneless.stable = false;

      const result = checker.checkCompatibility(capabilities);
      expect(result.compatible).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes for Angular 21 modern capabilities', () => {
      const result = checker.checkCompatibility(baseCapabilities('21.0.1'));
      expect(result.compatible).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('warns for zoneless usage before Angular 20', () => {
      const capabilities = baseCapabilities('19.0.0');
      capabilities.rendering.zoneless.enabled = true;
      capabilities.rendering.zoneless.stable = false;

      const result = checker.checkCompatibility(capabilities);
      expect(result.compatible).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('experimental before Angular 20'),
      );
    });

    it('fails for unsupported Angular version', () => {
      const result = checker.checkCompatibility(baseCapabilities('17.3.0'));
      expect(result.compatible).toBe(false);
      expect(result.errors).toContainEqual(expect.stringContaining('is not supported'));
    });

    it('fails for incremental hydration on Angular 18', () => {
      const capabilities = baseCapabilities('18.2.0');
      const result = checker.checkCompatibility(capabilities);
      expect(result.compatible).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('Incremental hydration requires Angular 19+'),
      );
    });

    it('fails for linkedSignal on Angular 18', () => {
      const capabilities = baseCapabilities('18.2.0');
      capabilities.rendering.hydration.incremental = false;
      const result = checker.checkCompatibility(capabilities);
      expect(result.compatible).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('linkedSignal requires Angular 19+'),
      );
    });

    it('adds note for static-only deployment', () => {
      const capabilities = baseCapabilities('20.0.0');
      capabilities.rendering.needsServer = false;
      capabilities.ssr.enabled = false;
      capabilities.api.enabled = false;

      const result = checker.checkCompatibility(capabilities);
      expect(result.notes).toContainEqual(
        expect.stringContaining('Static deployment mode detected'),
      );
    });

    it('adds note for prerender enabled without routes', () => {
      const capabilities = baseCapabilities('20.0.0');
      capabilities.prerender.routes = [];

      const result = checker.checkCompatibility(capabilities);
      expect(result.notes).toContainEqual(
        expect.stringContaining('Prerendering enabled without explicit routes'),
      );
    });
  });

  describe('isVersionSupported', () => {
    it('supports Angular 18.x', () => {
      expect(checker.isVersionSupported('18.0.0')).toBe(true);
      expect(checker.isVersionSupported('18.2.5')).toBe(true);
    });

    it('supports Angular 19.x', () => {
      expect(checker.isVersionSupported('19.0.0')).toBe(true);
      expect(checker.isVersionSupported('19.3.1')).toBe(true);
    });

    it('supports Angular 20.x', () => {
      expect(checker.isVersionSupported('20.0.0')).toBe(true);
      expect(checker.isVersionSupported('20.1.9')).toBe(true);
    });

    it('supports Angular 21.x', () => {
      expect(checker.isVersionSupported('21.0.0')).toBe(true);
      expect(checker.isVersionSupported('21.2.4')).toBe(true);
    });

    it('does not support Angular 17 and below', () => {
      expect(checker.isVersionSupported('17.3.0')).toBe(false);
      expect(checker.isVersionSupported('16.2.0')).toBe(false);
    });

    it('handles invalid version input', () => {
      expect(checker.isVersionSupported('invalid')).toBe(false);
      expect(checker.isVersionSupported('')).toBe(false);
    });
  });

  describe('getFeatureSupport', () => {
    it('returns expected support for Angular 18', () => {
      const support = checker.getFeatureSupport('18.2.0');
      expect(support.ssr).toBe(true);
      expect(support.incrementalHydration).toBe(false);
      expect(support.linkedSignal).toBe(false);
      expect(support.zoneless).toBe(false);
    });

    it('returns expected support for Angular 19', () => {
      const support = checker.getFeatureSupport('19.1.0');
      expect(support.ssr).toBe(true);
      expect(support.incrementalHydration).toBe(true);
      expect(support.linkedSignal).toBe(true);
      expect(support.zoneless).toBe(false);
    });

    it('returns expected support for Angular 20', () => {
      const support = checker.getFeatureSupport('20.0.0');
      expect(support.ssr).toBe(true);
      expect(support.incrementalHydration).toBe(true);
      expect(support.zoneless).toBe(true);
      expect(support.responseCache).toBe(true);
    });

    it('returns expected support for Angular 21', () => {
      const support = checker.getFeatureSupport('21.0.0');
      expect(support.ssr).toBe(true);
      expect(support.prerender).toBe(true);
      expect(support.expressApiRoutes).toBe(true);
      expect(support.responseCache).toBe(true);
    });

    it('returns Yandex Cloud limitations metadata', () => {
      const limitations = checker.getYCLimitations();
      expect(limitations.length).toBeGreaterThan(0);
      expect(limitations[0]).toHaveProperty('limitation');
      expect(limitations[0]).toHaveProperty('impact');
    });
  });
});
