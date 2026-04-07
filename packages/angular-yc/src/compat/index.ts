import yaml from 'js-yaml';
import fs from 'fs-extra';
import semver from 'semver';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Capabilities } from '../manifest/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface FeatureStatus {
  status: 'supported' | 'partial' | 'unsupported' | 'experimental';
  notes?: string;
}

export interface VersionFeatures {
  range: string;
  features: Record<string, FeatureStatus>;
}

export interface CompatMatrix {
  versions: VersionFeatures[];
  ycLimitations: Array<{
    limitation: string;
    value: string;
    impact: string;
  }>;
  runtimeNotes?: Array<{
    note: string;
  }>;
}

export class CompatibilityChecker {
  private matrix: CompatMatrix;

  constructor() {
    const matrixPath = path.join(__dirname, 'compat.yml');
    const matrixContent = fs.readFileSync(matrixPath, 'utf-8');
    this.matrix = yaml.load(matrixContent) as CompatMatrix;
  }

  isVersionSupported(version: string): boolean {
    const normalized = this.normalizeVersion(version);
    if (!normalized) {
      return false;
    }

    return this.matrix.versions.some((v) => semver.satisfies(normalized, v.range));
  }

  getFeatureCompatibility(version: string, feature: string): FeatureStatus | undefined {
    const versionEntry = this.getVersionEntry(version);
    return versionEntry?.features[feature];
  }

  getAllFeatures(version: string): Record<string, FeatureStatus> | undefined {
    return this.getVersionEntry(version)?.features;
  }

  checkCapabilities(
    angularVersion: string,
    capabilities: {
      ssr: boolean;
      prerender: boolean;
      expressApiRoutes: boolean;
      hydration: boolean;
      incrementalHydration: boolean;
      signals: boolean;
      linkedSignal: boolean;
      resourceApi: boolean;
      zoneless: boolean;
      ngOptimizedImage: boolean;
      responseCache: boolean;
    },
  ): {
    compatible: boolean;
    warnings: string[];
    errors: string[];
  } {
    const warnings: string[] = [];
    const errors: string[] = [];

    const normalized = this.normalizeVersion(angularVersion);
    if (!normalized || !this.isVersionSupported(normalized)) {
      errors.push(
        `Angular version ${angularVersion} is not supported. Supported ranges: ${this.matrix.versions
          .map((v) => v.range)
          .join(', ')}`,
      );
      return { compatible: false, warnings, errors };
    }

    const features = this.getAllFeatures(normalized);
    if (!features) {
      errors.push(`Could not determine compatibility for Angular ${normalized}`);
      return { compatible: false, warnings, errors };
    }

    const checks = [
      { enabled: capabilities.ssr, feature: 'ssr', name: 'SSR' },
      { enabled: capabilities.prerender, feature: 'prerender', name: 'Prerendering' },
      {
        enabled: capabilities.expressApiRoutes,
        feature: 'expressApiRoutes',
        name: 'Express API routes',
      },
      { enabled: capabilities.hydration, feature: 'hydration', name: 'Hydration' },
      {
        enabled: capabilities.incrementalHydration,
        feature: 'incrementalHydration',
        name: 'Incremental hydration',
      },
      { enabled: capabilities.signals, feature: 'signals', name: 'Signals' },
      { enabled: capabilities.linkedSignal, feature: 'linkedSignal', name: 'linkedSignal' },
      { enabled: capabilities.resourceApi, feature: 'resourceApi', name: 'resource API' },
      { enabled: capabilities.zoneless, feature: 'zoneless', name: 'Zoneless mode' },
      {
        enabled: capabilities.ngOptimizedImage,
        feature: 'ngOptimizedImage',
        name: 'NgOptimizedImage',
      },
      {
        enabled: capabilities.responseCache,
        feature: 'responseCache',
        name: 'Response cache',
      },
    ];

    for (const check of checks) {
      if (!check.enabled) {
        continue;
      }

      const status = features[check.feature];
      if (!status) {
        warnings.push(`Feature '${check.name}' status unknown for Angular ${normalized}`);
        continue;
      }

      if (status.status === 'unsupported') {
        errors.push(`Feature '${check.name}' is not supported in Angular ${normalized}`);
      }

      if (status.status === 'partial' || status.status === 'experimental') {
        warnings.push(
          `Feature '${check.name}' is ${status.status} in Angular ${normalized}${
            status.notes ? `: ${status.notes}` : ''
          }`,
        );
      }
    }

    return {
      compatible: errors.length === 0,
      warnings,
      errors,
    };
  }

  checkCompatibility(capabilities: Capabilities): {
    compatible: boolean;
    warnings: string[];
    errors: string[];
    notes: string[];
  } {
    const notes: string[] = [];

    const result = this.checkCapabilities(capabilities.angularVersion, {
      ssr: capabilities.ssr.enabled,
      prerender: capabilities.prerender.enabled,
      expressApiRoutes: capabilities.api.enabled,
      hydration: capabilities.rendering.hydration.enabled,
      incrementalHydration: capabilities.rendering.hydration.incremental,
      signals: capabilities.rendering.signals.enabled,
      linkedSignal: capabilities.rendering.signals.linkedSignal,
      resourceApi: capabilities.rendering.signals.resourceApi,
      zoneless: capabilities.rendering.zoneless.enabled,
      ngOptimizedImage: capabilities.assets.ngOptimizedImage,
      responseCache: capabilities.responseCache.enabled,
    });

    const normalized =
      this.normalizeVersion(capabilities.angularVersion) || capabilities.angularVersion;

    if (capabilities.rendering.hydration.incremental && semver.satisfies(normalized, '<19.0.0')) {
      result.errors.push('Incremental hydration requires Angular 19+');
      result.compatible = false;
    }

    if (capabilities.rendering.signals.linkedSignal && semver.satisfies(normalized, '<19.0.0')) {
      result.errors.push('linkedSignal requires Angular 19+');
      result.compatible = false;
    }

    if (capabilities.rendering.zoneless.enabled && semver.satisfies(normalized, '<20.0.0')) {
      result.warnings.push('Zoneless mode is experimental before Angular 20');
    }

    if (!capabilities.rendering.needsServer) {
      notes.push('Static deployment mode detected (no server function required).');
    }

    if (capabilities.prerender.enabled && capabilities.prerender.routes.length === 0) {
      notes.push(
        'Prerendering enabled without explicit routes; fallback to runtime route discovery.',
      );
    }

    return {
      compatible: result.errors.length === 0,
      warnings: result.warnings,
      errors: result.errors,
      notes,
    };
  }

  getFeatureSupport(version: string): {
    ssr: boolean;
    prerender: boolean;
    expressApiRoutes: boolean;
    hydration: boolean;
    incrementalHydration: boolean;
    signals: boolean;
    linkedSignal: boolean;
    resourceApi: boolean;
    zoneless: boolean;
    responseCache: boolean;
  } {
    const features = this.getAllFeatures(version);

    const isSupported = (feature: string): boolean => {
      const status = features?.[feature];
      return status?.status === 'supported' || status?.status === 'partial';
    };

    const isAvailable = (feature: string): boolean => {
      const status = features?.[feature];
      return (
        status?.status === 'supported' ||
        status?.status === 'partial' ||
        status?.status === 'experimental'
      );
    };

    return {
      ssr: isSupported('ssr'),
      prerender: isSupported('prerender'),
      expressApiRoutes: isSupported('expressApiRoutes'),
      hydration: isSupported('hydration'),
      incrementalHydration: isSupported('incrementalHydration'),
      signals: isSupported('signals'),
      linkedSignal: isSupported('linkedSignal'),
      resourceApi: isAvailable('resourceApi'),
      zoneless: isSupported('zoneless'),
      responseCache: isSupported('responseCache'),
    };
  }

  getYCLimitations() {
    return this.matrix.ycLimitations;
  }

  getRuntimeNotes() {
    return this.matrix.runtimeNotes || [];
  }

  private getVersionEntry(version: string): VersionFeatures | undefined {
    const normalized = this.normalizeVersion(version);
    if (!normalized) {
      return undefined;
    }

    return this.matrix.versions.find((v) => semver.satisfies(normalized, v.range));
  }

  private normalizeVersion(version: string): string | undefined {
    const cleaned = version.trim().replace(/^[\^~><= ]+/, '');
    return semver.valid(cleaned) ?? semver.valid(semver.coerce(cleaned)) ?? undefined;
  }
}
