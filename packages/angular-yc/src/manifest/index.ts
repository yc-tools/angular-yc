import fs from 'fs-extra';
import path from 'path';
import { Capabilities, createDefaultManifest, DeployManifest, validateManifest } from './schema.js';

export interface ManifestGeneratorOptions {
  buildDir: string;
  outputPath: string;
  verbose?: boolean;
}

export class ManifestGenerator {
  async generate(options: ManifestGeneratorOptions): Promise<DeployManifest> {
    const { buildDir, outputPath } = options;

    if (!(await fs.pathExists(buildDir))) {
      throw new Error(`Build directory not found: ${buildDir}`);
    }

    const existingManifestPath = path.join(buildDir, 'deploy.manifest.json');

    if (await fs.pathExists(existingManifestPath)) {
      const manifestData = await fs.readJson(existingManifestPath);
      const manifest = validateManifest(manifestData);

      if (path.resolve(existingManifestPath) !== path.resolve(outputPath)) {
        await fs.copy(existingManifestPath, outputPath);
      }

      return manifest;
    }

    const capabilitiesPath = path.join(buildDir, 'capabilities.json');
    if (!(await fs.pathExists(capabilitiesPath))) {
      throw new Error(
        'No manifest or capabilities file found. Please run "angular-yc build" first.',
      );
    }

    const capabilities = (await fs.readJson(capabilitiesPath)) as Capabilities;
    const projectName = await this.detectProjectName(buildDir);
    const buildId = await this.detectBuildId(buildDir);

    const manifest = createDefaultManifest(buildId, projectName, capabilities);
    manifest.routing.openapiTemplatePath = './openapi-template.json';

    if (capabilities.rendering.needsServer) {
      manifest.artifacts.server = {
        zipPath: './artifacts/server.zip',
        entry: 'index.handler',
        env: {
          NODE_ENV: 'production',
          YC_ANGULAR_BUILD_ID: buildId,
        },
      };
    }

    if (capabilities.assets.needsImage) {
      manifest.artifacts.image = {
        zipPath: './artifacts/image.zip',
        entry: 'image.handler',
        env: {
          NODE_ENV: 'production',
        },
      };
    }

    const validated = validateManifest(manifest);
    await fs.writeJson(outputPath, validated, { spaces: 2 });

    return validated;
  }

  private async detectBuildId(buildDir: string): Promise<string> {
    const buildIdPath = path.join(buildDir, 'artifacts', 'assets', 'BUILD_ID');
    if (await fs.pathExists(buildIdPath)) {
      const buildId = await fs.readFile(buildIdPath, 'utf-8');
      return buildId.trim();
    }

    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `build-${timestamp}-${random}`;
  }

  private async detectProjectName(buildDir: string): Promise<string> {
    const projectMetaPath = path.join(buildDir, 'project.meta.json');
    if (await fs.pathExists(projectMetaPath)) {
      const meta = await fs.readJson(projectMetaPath);
      if (typeof meta?.projectName === 'string' && meta.projectName.length > 0) {
        return meta.projectName;
      }
    }
    return 'angular-app';
  }
}
