import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import chalk from 'chalk';
import { Capabilities } from '../manifest/schema.js';
import { CompatibilityChecker } from '../compat/index.js';

interface AngularWorkspace {
  defaultProject?: string;
  projects?: Record<string, AngularProject>;
}

interface AngularProject {
  root?: string;
  sourceRoot?: string;
  architect?: Record<string, AngularTarget>;
}

interface AngularTarget {
  builder?: string;
  options?: Record<string, unknown>;
  configurations?: Record<string, Record<string, unknown>>;
}

export interface AnalyzeOptions {
  projectPath: string;
  outputDir?: string;
  verbose?: boolean;
  projectName?: string;
}

export type AnalyzeCapabilities = Capabilities;

export class Analyzer {
  private readonly compat: CompatibilityChecker;

  constructor() {
    this.compat = new CompatibilityChecker();
  }

  async analyze(options: AnalyzeOptions): Promise<Capabilities> {
    const { projectPath, outputDir, verbose } = options;

    if (!(await fs.pathExists(projectPath))) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    const angularVersion = await this.detectAngularVersion(projectPath);
    const workspace = await this.loadWorkspace(projectPath);
    const projectName = this.resolveProjectName(workspace, options.projectName);
    const projectConfig = workspace.projects?.[projectName];

    if (!projectConfig) {
      throw new Error(`Could not resolve project '${projectName}' in angular.json`);
    }

    const ssr = await this.detectSSR(projectPath, projectConfig, angularVersion);
    const prerender = await this.detectPrerender(projectPath, projectConfig);
    const api = await this.detectAPI(projectPath, ssr.entrypoint);
    const lazyLoading = await this.detectPatternUsage(projectPath, [
      'loadChildren',
      'loadComponent',
    ]);
    const signalsEnabled = await this.detectPatternUsage(projectPath, [
      'signal(',
      'computed(',
      'effect(',
    ]);
    const linkedSignal = await this.detectPatternUsage(projectPath, ['linkedSignal(']);
    const resourceApi = await this.detectPatternUsage(projectPath, ['resource(']);
    const hydrationEnabled = await this.detectPatternUsage(projectPath, [
      'provideClientHydration(',
    ]);
    const incrementalHydration = await this.detectPatternUsage(projectPath, [
      'withIncrementalHydration(',
    ]);
    const zonelessExperimental = await this.detectPatternUsage(projectPath, [
      'provideExperimentalZonelessChangeDetection(',
    ]);
    const zonelessStable = await this.detectPatternUsage(projectPath, [
      'provideZonelessChangeDetection(',
    ]);
    const standalone = await this.detectPatternUsage(projectPath, ['bootstrapApplication(']);
    const ngOptimizedImage = await this.detectPatternUsage(projectPath, [
      'NgOptimizedImage',
      'ngSrc',
    ]);

    const needsServer = ssr.enabled || api.enabled;

    const capabilities: Capabilities = {
      angularVersion,
      ssr,
      prerender,
      api,
      rendering: {
        needsServer,
        lazyLoading,
        standalone,
        hydration: {
          enabled: hydrationEnabled,
          incremental: incrementalHydration,
        },
        signals: {
          enabled: signalsEnabled,
          linkedSignal,
          resourceApi,
        },
        zoneless: {
          enabled: zonelessExperimental || zonelessStable,
          stable: zonelessStable,
        },
      },
      assets: {
        needsImage: ngOptimizedImage,
        ngOptimizedImage,
      },
      responseCache: {
        enabled: needsServer,
        defaultTtlSeconds: 60,
        staleWhileRevalidateSeconds: 30,
        varyHeaders: ['accept-language', 'accept-encoding'],
        bypassPaths: ['/api/*'],
        purgePath: '/api/__cache/purge',
        tagsEnabled: true,
      },
      notes: [],
    };

    const compatCheck = this.compat.checkCapabilities(angularVersion, {
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

    if (!compatCheck.compatible) {
      if (verbose) {
        for (const error of compatCheck.errors) {
          console.error(chalk.red(`❌ ${error}`));
        }
      }
      throw new Error('Project has incompatible features for YC Angular deployment');
    }

    if (compatCheck.warnings.length > 0) {
      capabilities.notes.push(...compatCheck.warnings);
    }

    if (outputDir) {
      await fs.ensureDir(outputDir);
      await fs.writeJson(path.join(outputDir, 'capabilities.json'), capabilities, { spaces: 2 });
      await fs.writeJson(path.join(outputDir, 'project.meta.json'), { projectName }, { spaces: 2 });
    }

    if (verbose) {
      this.printCapabilities(projectName, capabilities);
    }

    return capabilities;
  }

  private async detectAngularVersion(projectPath: string): Promise<string> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!(await fs.pathExists(packageJsonPath))) {
      throw new Error('package.json not found in project');
    }

    const packageJson = await fs.readJson(packageJsonPath);
    const versionValue =
      packageJson.dependencies?.['@angular/core'] || packageJson.devDependencies?.['@angular/core'];

    if (!versionValue) {
      throw new Error('@angular/core not found in package.json dependencies');
    }

    return String(versionValue).replace(/^[\^~><= ]+/, '');
  }

  private async loadWorkspace(projectPath: string): Promise<AngularWorkspace> {
    const angularJsonPath = path.join(projectPath, 'angular.json');

    if (!(await fs.pathExists(angularJsonPath))) {
      throw new Error('angular.json not found in project');
    }

    return (await fs.readJson(angularJsonPath)) as AngularWorkspace;
  }

  private resolveProjectName(workspace: AngularWorkspace, explicit?: string): string {
    if (explicit) {
      return explicit;
    }

    if (workspace.defaultProject) {
      return workspace.defaultProject;
    }

    const firstProject = Object.keys(workspace.projects || {})[0];
    if (!firstProject) {
      throw new Error('No projects found in angular.json');
    }

    return firstProject;
  }

  private async detectSSR(
    projectPath: string,
    projectConfig: AngularProject,
    angularVersion: string,
  ): Promise<Capabilities['ssr']> {
    const targets = projectConfig.architect || {};
    const hasServerTarget = Boolean(targets.server || targets.ssr);

    const serverCandidates = ['server.ts', 'src/server.ts'];
    let entrypoint: string | undefined;
    for (const candidate of serverCandidates) {
      const fullPath = path.join(projectPath, candidate);
      if (await fs.pathExists(fullPath)) {
        entrypoint = candidate;
        break;
      }
    }

    const hasSSRDependency = await this.hasDependency(projectPath, '@angular/ssr');
    const enabled = hasSSRDependency || hasServerTarget || Boolean(entrypoint);

    let expressAdapter: Capabilities['ssr']['expressAdapter'] = 'none';
    if (entrypoint) {
      const content = await fs.readFile(path.join(projectPath, entrypoint), 'utf-8');
      if (content.includes('express(') || content.includes('express()')) {
        expressAdapter = 'express-app';
      } else if (content.includes('handle') || content.includes('renderApplication')) {
        expressAdapter = 'request-handler';
      }
    }

    const standaloneBundle = this.isStandaloneBundle(projectConfig, angularVersion);

    return {
      enabled,
      entrypoint,
      expressAdapter,
      standaloneBundle,
    };
  }

  private async detectPrerender(
    projectPath: string,
    projectConfig: AngularProject,
  ): Promise<Capabilities['prerender']> {
    const targets = projectConfig.architect || {};
    const prerenderTarget = targets.prerender;

    const routesFilePath = path.join(projectPath, 'prerender-routes.txt');
    const routesFromFile = (await fs.pathExists(routesFilePath))
      ? (await fs.readFile(routesFilePath, 'utf-8'))
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];

    const optionsRoutes = Array.isArray(prerenderTarget?.options?.routes)
      ? (prerenderTarget?.options?.routes as string[])
      : [];

    const routes = [...new Set([...optionsRoutes, ...routesFromFile])];

    const discoveredFrom: Capabilities['prerender']['discoveredFrom'] = optionsRoutes.length
      ? 'angular-json'
      : routesFromFile.length
        ? 'routes-file'
        : prerenderTarget
          ? 'router-analysis'
          : 'none';

    return {
      enabled: Boolean(prerenderTarget) || routes.length > 0,
      routes,
      discoveredFrom,
    };
  }

  private async detectAPI(projectPath: string, entrypoint?: string): Promise<Capabilities['api']> {
    const candidates = [entrypoint, 'server.ts', 'src/server.ts'].filter(Boolean) as string[];

    const routeSet = new Set<string>();

    for (const candidate of candidates) {
      const fullPath = path.join(projectPath, candidate);
      if (!(await fs.pathExists(fullPath))) {
        continue;
      }

      const content = await fs.readFile(fullPath, 'utf-8');
      const routeMatches = content.matchAll(
        /app\.(?:get|post|put|patch|delete|all|use)\((['"`])([^'"`]+)\1/g,
      );

      for (const match of routeMatches) {
        const route = match[2];
        if (route.startsWith('/api')) {
          routeSet.add(route);
        }
      }

      if (content.includes('/api')) {
        routeSet.add('/api');
      }
    }

    const routesDetected = Array.from(routeSet).sort();

    return {
      enabled: routesDetected.length > 0,
      framework: 'express',
      basePath: '/api',
      routesDetected,
    };
  }

  private async detectPatternUsage(projectPath: string, patterns: string[]): Promise<boolean> {
    const files = await glob('**/*.{ts,tsx,js,mjs,cjs,html}', {
      cwd: projectPath,
      ignore: ['node_modules/**', 'dist/**', '.angular/**'],
      nodir: true,
    });

    for (const file of files) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      for (const pattern of patterns) {
        if (content.includes(pattern)) {
          return true;
        }
      }
    }

    return false;
  }

  private async hasDependency(projectPath: string, dependencyName: string): Promise<boolean> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!(await fs.pathExists(packageJsonPath))) {
      return false;
    }

    const packageJson = await fs.readJson(packageJsonPath);
    return Boolean(
      packageJson.dependencies?.[dependencyName] || packageJson.devDependencies?.[dependencyName],
    );
  }

  private isStandaloneBundle(projectConfig: AngularProject, angularVersion: string): boolean {
    const buildTarget = projectConfig.architect?.build;
    if (buildTarget?.builder === '@angular-devkit/build-angular:application') {
      return true;
    }

    const major = Number.parseInt(angularVersion.split('.')[0] || '0', 10);
    return major >= 19;
  }

  private printCapabilities(projectName: string, capabilities: Capabilities): void {
    console.log(chalk.cyan('\n📋 Angular Capabilities'));
    console.log(chalk.gray(`  Project: ${projectName}`));
    console.log(chalk.gray(`  Angular: ${capabilities.angularVersion}`));
    console.log(chalk.gray(`  SSR: ${capabilities.ssr.enabled ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  Prerender: ${capabilities.prerender.enabled ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  API routes: ${capabilities.api.enabled ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  Needs server: ${capabilities.rendering.needsServer ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  Lazy loading: ${capabilities.rendering.lazyLoading ? 'yes' : 'no'}`));
    console.log(
      chalk.gray(`  Hydration: ${capabilities.rendering.hydration.enabled ? 'yes' : 'no'}`),
    );
    console.log(
      chalk.gray(
        `  Incremental hydration: ${capabilities.rendering.hydration.incremental ? 'yes' : 'no'}`,
      ),
    );
    console.log(chalk.gray(`  Signals: ${capabilities.rendering.signals.enabled ? 'yes' : 'no'}`));
    console.log(
      chalk.gray(`  Zoneless: ${capabilities.rendering.zoneless.enabled ? 'yes' : 'no'}`),
    );
    console.log(
      chalk.gray(`  Image optimization: ${capabilities.assets.needsImage ? 'yes' : 'no'}`),
    );

    if (capabilities.notes.length > 0) {
      console.log(chalk.yellow('\n⚠️  Notes:'));
      for (const note of capabilities.notes) {
        console.log(chalk.yellow(`  - ${note}`));
      }
    }
  }
}
