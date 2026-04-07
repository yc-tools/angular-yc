#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { Analyzer } from './analyze/index.js';
import { Builder } from './build/index.js';
import { ManifestGenerator } from './manifest/index.js';
import { Uploader } from './upload/index.js';
import {
  cleanupTerraformProject,
  extractOutputString,
  migrateLegacyModuleState,
  prepareTerraformProject,
  resolveBackendConfig,
  TerraformRunner,
} from './terraform/index.js';
import {
  firstDefined,
  getConfigBoolean,
  getConfigRecord,
  getConfigString,
  getEnvBoolean,
  getEnvString,
  loadAngularYcConfig,
} from './config/index.js';

const program = new Command();

program
  .name('angular-yc')
  .description('CLI tool for deploying Angular applications to Yandex Cloud')
  .version('1.0.0');

function cliOptionValue<T>(command: Command, name: string, value: T): T | undefined {
  return command.getOptionValueSource(name) === 'cli' ? value : undefined;
}

function parseTfVarAssignments(assignments: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of assignments) {
    const index = raw.indexOf('=');
    if (index <= 0) {
      throw new Error(`Invalid --tf-var value "${raw}". Expected key=value.`);
    }

    const key = raw.slice(0, index).trim().replace(/-/g, '_');
    const value = raw.slice(index + 1).trim();
    if (!key) {
      throw new Error(`Invalid --tf-var value "${raw}". Variable key is empty.`);
    }

    result[key] = value;
  }
  return result;
}

function collectTfVarsFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('AYC_TF_VAR_') || value === undefined) {
      continue;
    }

    const tfVarKey = key.slice('AYC_TF_VAR_'.length).toLowerCase();
    if (!tfVarKey) {
      continue;
    }

    result[tfVarKey] = value;
  }
  return result;
}

function collectTfVarsFromConfig(config: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  const tfVars = getConfigRecord(config, 'tfVars');
  if (!tfVars) {
    return result;
  }

  for (const [key, value] of Object.entries(tfVars)) {
    if (value === undefined || value === null) {
      continue;
    }
    result[key.replace(/-/g, '_')] = String(value);
  }

  return result;
}

/** Collect AYC_ENV_ prefixed vars and strip the prefix to get Cloud Function env vars. */
function collectCustomEnvVars(env: NodeJS.ProcessEnv): Record<string, string> {
  const PREFIX = 'AYC_ENV_';
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(PREFIX) || value === undefined) continue;
    const envKey = key.slice(PREFIX.length);
    if (envKey) result[envKey] = value;
  }
  return result;
}

function buildTerraformVarEnv(options: {
  appName?: string;
  environment?: string;
  domainName?: string;
  cloudId?: string;
  folderId?: string;
  iamToken?: string;
  zone?: string;
  region?: string;
  dnsZoneId?: string;
  certificateId?: string;
  createDnsZone?: boolean;
  storageAccessKey?: string;
  storageSecretKey?: string;
  tfVarAssignments?: Record<string, string>;
  envTfVars?: Record<string, string>;
  configTfVars?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};

  const mapped = new Map<string, string | boolean | undefined>([
    ['app_name', options.appName],
    ['env', options.environment],
    ['domain_name', options.domainName],
    ['cloud_id', options.cloudId],
    ['folder_id', options.folderId],
    ['iam_token', options.iamToken],
    ['zone', options.zone],
    ['region', options.region],
    ['dns_zone_id', options.dnsZoneId],
    ['certificate_id', options.certificateId],
    ['create_dns_zone', options.createDnsZone],
    ['storage_access_key', options.storageAccessKey],
    ['storage_secret_key', options.storageSecretKey],
  ]);

  for (const [key, value] of mapped.entries()) {
    if (value === undefined) {
      continue;
    }
    output[`TF_VAR_${key}`] = String(value);
  }

  const mergedTfVars = {
    ...(options.configTfVars || {}),
    ...(options.envTfVars || {}),
    ...(options.tfVarAssignments || {}),
  };

  for (const [key, value] of Object.entries(mergedTfVars)) {
    output[`TF_VAR_${key}`] = value;
  }

  return output;
}

function buildBackendInput(options: {
  stateBucket?: string;
  stateKey?: string;
  stateRegion?: string;
  stateEndpoint?: string;
  stateAccessKey?: string;
  stateSecretKey?: string;
}) {
  return {
    stateBucket: options.stateBucket,
    stateKey: options.stateKey,
    stateRegion: options.stateRegion,
    stateEndpoint: options.stateEndpoint,
    stateAccessKey: options.stateAccessKey,
    stateSecretKey: options.stateSecretKey,
  };
}

function stripAnsi(input: string): string {
  const escape = String.fromCharCode(27);
  const ansiPattern = new RegExp(`${escape}\\[[0-9;]*[A-Za-z]`, 'g');
  return input.replace(ansiPattern, '');
}

function extractMissingLatestFunctionTargets(message: string): string[] {
  const normalized = stripAnsi(message);

  if (!/tag\s+\\?\$latest\s+not\s+found/i.test(normalized)) {
    return [];
  }

  const targets = new Set<string>();
  const resourceMatches = normalized.matchAll(/with\s+([a-zA-Z0-9_.[\]-]+)\s*,/g);
  for (const match of resourceMatches) {
    const target = match[1];
    if (target.includes('yandex_function.')) {
      targets.add(target);
    }
  }

  return Array.from(targets);
}

function isApiGatewaySpecInconsistentPlanError(message: string): boolean {
  const normalized = stripAnsi(message);

  return (
    /Provider produced inconsistent final plan/i.test(normalized) &&
    /yandex_api_gateway\.main/i.test(normalized) &&
    /invalid new value for \.spec/i.test(normalized)
  );
}

function isLockboxPermissionDeniedOnFunctionVersionCreate(message: string): boolean {
  const normalized = stripAnsi(message);

  return (
    /create version for yandex cloud function/i.test(normalized) &&
    /lockbox:PERMISSION_DENIED/i.test(normalized)
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyWithMissingLatestRecovery(
  terraform: TerraformRunner,
  options: { autoApprove: boolean; env?: NodeJS.ProcessEnv; verbose?: boolean },
): Promise<void> {
  try {
    await terraform.apply({
      autoApprove: options.autoApprove,
      env: options.env,
    });
  } catch (error) {
    let effectiveError: unknown = error;
    let message = error instanceof Error ? error.message : String(error);

    if (isApiGatewaySpecInconsistentPlanError(message)) {
      console.warn(
        chalk.yellow(
          '⚠️ Detected Yandex provider inconsistent API Gateway spec plan. Retrying terraform apply once in-place.',
        ),
      );

      try {
        await terraform.apply({
          autoApprove: options.autoApprove,
          env: options.env,
        });

        if (options.verbose) {
          console.log(chalk.gray('↪️ Terraform apply retry after inconsistent plan succeeded'));
        }

        return;
      } catch (retryError) {
        effectiveError = retryError;
        message = retryError instanceof Error ? retryError.message : String(retryError);
      }
    }

    if (isLockboxPermissionDeniedOnFunctionVersionCreate(message)) {
      console.warn(
        chalk.yellow(
          '⚠️ Detected Lockbox permission propagation delay during function version create. Retrying terraform apply once in-place.',
        ),
      );

      await sleep(8000);

      try {
        await terraform.apply({
          autoApprove: options.autoApprove,
          env: options.env,
        });

        if (options.verbose) {
          console.log(
            chalk.gray('↪️ Terraform apply retry after lockbox permission delay succeeded'),
          );
        }

        return;
      } catch (retryError) {
        effectiveError = retryError;
        message = retryError instanceof Error ? retryError.message : String(retryError);
      }
    }

    let replaceTargets = extractMissingLatestFunctionTargets(message);

    if (
      replaceTargets.length === 0 &&
      /tag\s+\\?\$latest\s+not\s+found/i.test(stripAnsi(message))
    ) {
      const stateTargets = await terraform.listState(options.env);
      replaceTargets = stateTargets.filter((target) => target.includes('yandex_function.'));
    }

    if (replaceTargets.length === 0) {
      throw effectiveError;
    }

    console.warn(
      chalk.yellow(
        `⚠️ Recovering from missing $latest function versions by replacing: ${replaceTargets.join(', ')}`,
      ),
    );

    await terraform.apply({
      autoApprove: options.autoApprove,
      replace: replaceTargets,
      refresh: false,
      env: options.env,
    });

    if (options.verbose) {
      console.log(chalk.gray('↪️ Terraform apply retry with -replace succeeded'));
    }
  }
}

program
  .command('analyze')
  .description('Analyze Angular project capabilities')
  .requiredOption('-p, --project <path>', 'Path to Angular project')
  .option('--project-name <name>', 'Angular project name from angular.json')
  .option('-o, --output <dir>', 'Output directory for analysis results')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const analyzer = new Analyzer();
      const projectPath = path.resolve(options.project);

      await analyzer.analyze({
        projectPath,
        projectName: options.projectName,
        outputDir: options.output ? path.resolve(options.output) : undefined,
        verbose: options.verbose,
      });

      console.log(chalk.green('✅ Analysis complete'));
    } catch (error) {
      console.error(
        chalk.red('❌ Analysis failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('deploy')
  .description('Build, upload artifacts, and run terraform apply')
  .option('-p, --project <path>', 'Path to Angular project')
  .option('--config <path>', 'Path to angular-yc config file')
  .option('-o, --output <dir>', 'Output directory for build artifacts')
  .option('--project-name <name>', 'Angular project name from angular.json')
  .option('-b, --build-id <id>', 'Custom build ID')
  .option('--skip-build', 'Skip Angular build and package existing dist')
  .option('--bucket <name>', 'Assets bucket name (or resolve from terraform output)')
  .option('--region <region>', 'YC region')
  .option('--endpoint <url>', 'S3 endpoint URL')
  .option('--app-name <name>', 'Terraform variable app_name')
  .option('--environment <name>', 'Terraform variable env')
  .option('--domain-name <name>', 'Terraform variable domain_name')
  .option(
    '--tf-var <key=value>',
    'Additional terraform variable (repeatable)',
    (value, acc) => {
      acc.push(value);
      return acc;
    },
    [] as string[],
  )
  .option('--state-bucket <name>', 'Terraform backend S3 bucket (or TF_STATE_BUCKET)')
  .option('--state-key <key>', 'Terraform backend key (or TF_STATE_KEY)')
  .option('--state-region <region>', 'Terraform backend region (or YC_REGION)')
  .option('--state-endpoint <url>', 'Terraform backend endpoint (or TF_STATE_ENDPOINT)')
  .option('--state-access-key <key>', 'Backend access key (or YC_ACCESS_KEY/AWS_ACCESS_KEY_ID)')
  .option('--state-secret-key <key>', 'Backend secret key (or YC_SECRET_KEY/AWS_SECRET_ACCESS_KEY)')
  .option('--auto-approve', 'Run terraform apply with -auto-approve')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options, command: Command) => {
    try {
      const env = process.env;
      const cliProject = cliOptionValue(command, 'project', options.project as string | undefined);
      const envProject = getEnvString(env, 'AYC_PROJECT');
      const loadedConfig = await loadAngularYcConfig({
        configPath: cliOptionValue(command, 'config', options.config as string | undefined),
        projectPath: firstDefined(cliProject, envProject),
      });
      const mergedConfig = {
        ...loadedConfig.data,
        ...(getConfigRecord(loadedConfig.data, 'deploy') || {}),
      };

      const projectInput = firstDefined(
        cliProject,
        envProject,
        getConfigString(mergedConfig, 'project'),
      );
      if (!projectInput) {
        throw new Error(
          'Project path is required. Provide --project, AYC_PROJECT, or config "project".',
        );
      }

      const projectPath = path.resolve(projectInput);
      const outputDir = path.resolve(
        firstDefined(
          cliOptionValue(command, 'output', options.output as string | undefined),
          getEnvString(env, 'AYC_OUTPUT'),
          getConfigString(mergedConfig, 'output'),
          './build',
        ) as string,
      );
      const deployRegion = firstDefined(
        cliOptionValue(command, 'region', options.region as string | undefined),
        getEnvString(env, 'AYC_REGION'),
        getConfigString(mergedConfig, 'region'),
        'ru-central1',
      ) as string;
      const deployEndpoint = firstDefined(
        cliOptionValue(command, 'endpoint', options.endpoint as string | undefined),
        getEnvString(env, 'AYC_ENDPOINT'),
        getConfigString(mergedConfig, 'endpoint'),
        'https://storage.yandexcloud.net',
      ) as string;

      const terraformDir = await prepareTerraformProject();

      try {
        const builder = new Builder();
        const uploader = new Uploader();
        const terraform = new TerraformRunner(terraformDir);

        const backend = resolveBackendConfig(
          buildBackendInput({
            stateBucket: firstDefined(
              cliOptionValue(command, 'stateBucket', options.stateBucket as string | undefined),
              getEnvString(env, 'AYC_STATE_BUCKET'),
              getConfigString(mergedConfig, 'stateBucket'),
            ),
            stateKey: firstDefined(
              cliOptionValue(command, 'stateKey', options.stateKey as string | undefined),
              getEnvString(env, 'AYC_STATE_KEY'),
              getConfigString(mergedConfig, 'stateKey'),
            ),
            stateRegion: firstDefined(
              cliOptionValue(command, 'stateRegion', options.stateRegion as string | undefined),
              getEnvString(env, 'AYC_STATE_REGION'),
              getConfigString(mergedConfig, 'stateRegion'),
            ),
            stateEndpoint: firstDefined(
              cliOptionValue(command, 'stateEndpoint', options.stateEndpoint as string | undefined),
              getEnvString(env, 'AYC_STATE_ENDPOINT'),
              getConfigString(mergedConfig, 'stateEndpoint'),
              'https://storage.yandexcloud.net',
            ),
            stateAccessKey: firstDefined(
              cliOptionValue(
                command,
                'stateAccessKey',
                options.stateAccessKey as string | undefined,
              ),
              getEnvString(env, 'AYC_STATE_ACCESS_KEY'),
              getConfigString(mergedConfig, 'stateAccessKey'),
            ),
            stateSecretKey: firstDefined(
              cliOptionValue(
                command,
                'stateSecretKey',
                options.stateSecretKey as string | undefined,
              ),
              getEnvString(env, 'AYC_STATE_SECRET_KEY'),
              getConfigString(mergedConfig, 'stateSecretKey'),
            ),
          }),
          {
            ...env,
            YC_REGION: firstDefined(getEnvString(env, 'YC_REGION'), deployRegion),
            YC_ACCESS_KEY: firstDefined(
              getEnvString(env, 'AYC_STORAGE_ACCESS_KEY'),
              getConfigString(mergedConfig, 'storageAccessKey'),
              getEnvString(env, 'YC_ACCESS_KEY'),
            ),
            YC_SECRET_KEY: firstDefined(
              getEnvString(env, 'AYC_STORAGE_SECRET_KEY'),
              getConfigString(mergedConfig, 'storageSecretKey'),
              getEnvString(env, 'YC_SECRET_KEY'),
            ),
          },
        );
        await terraform.init(backend || undefined);
        await migrateLegacyModuleState({
          runner: terraform,
          verbose: options.verbose,
        });

        await builder.build({
          projectPath,
          outputDir,
          projectName: firstDefined(
            cliOptionValue(command, 'projectName', options.projectName as string | undefined),
            getEnvString(env, 'AYC_PROJECT_NAME'),
            getConfigString(mergedConfig, 'projectName'),
          ),
          buildId: firstDefined(
            cliOptionValue(command, 'buildId', options.buildId as string | undefined),
            getEnvString(env, 'AYC_BUILD_ID'),
            getConfigString(mergedConfig, 'buildId'),
          ),
          verbose: options.verbose,
          skipBuild:
            firstDefined(
              cliOptionValue(command, 'skipBuild', options.skipBuild as boolean),
              getEnvBoolean(env, 'AYC_SKIP_BUILD'),
              getConfigBoolean(mergedConfig, 'skipBuild'),
            ) || false,
        });

        // Inject AYC_ENV_ prefixed variables into the manifest's server.env
        // so they become Cloud Function environment variables.
        const manifestPath = path.join(outputDir, 'deploy.manifest.json');
        const customEnv = collectCustomEnvVars(env);
        if (Object.keys(customEnv).length > 0) {
          const manifest = await fs.readJson(manifestPath);
          if (manifest.artifacts?.server) {
            manifest.artifacts.server.env = {
              ...manifest.artifacts.server.env,
              ...customEnv,
            };
            await fs.writeJson(manifestPath, manifest, { spaces: 2 });
            if (options.verbose) {
              console.log(
                chalk.gray(
                  `  Injected ${Object.keys(customEnv).length} custom env vars: ${Object.keys(customEnv).join(', ')}`,
                ),
              );
            }
          }
        }

        const outputs = await terraform.readOutputs();
        const explicitAssetsBucket = firstDefined(
          cliOptionValue(command, 'bucket', options.bucket as string | undefined),
          getEnvString(env, 'AYC_BUCKET'),
          getConfigString(mergedConfig, 'bucket'),
        );
        const assetsBucket = explicitAssetsBucket || extractOutputString(outputs, 'assets_bucket');

        if (!assetsBucket) {
          throw new Error(
            'Assets bucket is required for upload. Provide --bucket or set AYC_BUCKET/TF_VAR_assets_bucket_name.',
          );
        }

        await uploader.upload({
          buildDir: outputDir,
          assetsBucket,
          region: deployRegion,
          endpoint: deployEndpoint,
          verbose: options.verbose,
        });

        const terraformVarEnv = buildTerraformVarEnv({
          appName: firstDefined(
            cliOptionValue(command, 'appName', options.appName as string | undefined),
            getEnvString(env, 'AYC_APP_NAME'),
            getConfigString(mergedConfig, 'appName'),
          ),
          environment: firstDefined(
            cliOptionValue(command, 'environment', options.environment as string | undefined),
            getEnvString(env, 'AYC_ENV'),
            getConfigString(mergedConfig, 'environment'),
          ),
          domainName: firstDefined(
            cliOptionValue(command, 'domainName', options.domainName as string | undefined),
            getEnvString(env, 'AYC_DOMAIN_NAME'),
            getConfigString(mergedConfig, 'domainName'),
          ),
          cloudId: firstDefined(
            getEnvString(env, 'AYC_CLOUD_ID'),
            getConfigString(mergedConfig, 'cloudId'),
          ),
          folderId: firstDefined(
            getEnvString(env, 'AYC_FOLDER_ID'),
            getConfigString(mergedConfig, 'folderId'),
          ),
          iamToken: firstDefined(
            getEnvString(env, 'AYC_IAM_TOKEN'),
            getConfigString(mergedConfig, 'iamToken'),
          ),
          zone: firstDefined(getEnvString(env, 'AYC_ZONE'), getConfigString(mergedConfig, 'zone')),
          region: firstDefined(
            getEnvString(env, 'AYC_REGION'),
            getConfigString(mergedConfig, 'region'),
          ),
          dnsZoneId: firstDefined(
            getEnvString(env, 'AYC_DNS_ZONE_ID'),
            getConfigString(mergedConfig, 'dnsZoneId'),
          ),
          certificateId: firstDefined(
            getEnvString(env, 'AYC_CERTIFICATE_ID'),
            getConfigString(mergedConfig, 'certificateId'),
          ),
          createDnsZone: firstDefined(
            getEnvBoolean(env, 'AYC_CREATE_DNS_ZONE'),
            getConfigBoolean(mergedConfig, 'createDnsZone'),
          ),
          storageAccessKey: firstDefined(
            getEnvString(env, 'AYC_STORAGE_ACCESS_KEY'),
            getConfigString(mergedConfig, 'storageAccessKey'),
          ),
          storageSecretKey: firstDefined(
            getEnvString(env, 'AYC_STORAGE_SECRET_KEY'),
            getConfigString(mergedConfig, 'storageSecretKey'),
          ),
          configTfVars: collectTfVarsFromConfig(mergedConfig),
          envTfVars: collectTfVarsFromEnv(env),
          tfVarAssignments: parseTfVarAssignments(
            cliOptionValue(command, 'tfVar', options.tfVar as string[]) || [],
          ),
        });

        const applyEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...terraformVarEnv,
          TF_VAR_manifest_path: path.join(outputDir, 'deploy.manifest.json'),
          TF_VAR_build_dir: outputDir,
        };
        if (explicitAssetsBucket) {
          applyEnv.TF_VAR_assets_bucket_name = explicitAssetsBucket;
        }

        const autoApprove =
          firstDefined(
            cliOptionValue(command, 'autoApprove', options.autoApprove as boolean),
            getEnvBoolean(env, 'AYC_AUTO_APPROVE'),
            getConfigBoolean(mergedConfig, 'autoApprove'),
          ) || false;

        await applyWithMissingLatestRecovery(terraform, {
          autoApprove,
          env: applyEnv,
          verbose: options.verbose,
        });

        console.log(chalk.green('✅ Deploy complete'));
        console.log(chalk.cyan('📦 Assets bucket:'), assetsBucket);
        if (options.verbose && loadedConfig.path) {
          console.log(chalk.gray(`Config: ${loadedConfig.path}`));
        }
      } finally {
        await cleanupTerraformProject(terraformDir);
      }
    } catch (error) {
      console.error(
        chalk.red('❌ Deploy failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('build')
  .description('Build and package Angular app for YC deployment')
  .requiredOption('-p, --project <path>', 'Path to Angular project')
  .requiredOption('-o, --output <dir>', 'Output directory for build artifacts')
  .option('--project-name <name>', 'Angular project name from angular.json')
  .option('-b, --build-id <id>', 'Custom build ID')
  .option('-v, --verbose', 'Verbose output')
  .option('--skip-build', 'Skip Angular build and package existing dist')
  .action(async (options) => {
    try {
      const builder = new Builder();
      const projectPath = path.resolve(options.project);
      const outputDir = path.resolve(options.output);

      const manifest = await builder.build({
        projectPath,
        outputDir,
        projectName: options.projectName,
        buildId: options.buildId,
        verbose: options.verbose,
        skipBuild: options.skipBuild,
      });

      console.log(chalk.green('✅ Build complete'));
      console.log(chalk.cyan('📦 Artifacts:'), outputDir);
      console.log(chalk.cyan('🆔 Build ID:'), manifest.buildId);
    } catch (error) {
      console.error(
        chalk.red('❌ Build failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('deploy-manifest')
  .description('Generate deployment manifest from build artifacts')
  .requiredOption('-b, --build-dir <dir>', 'Build artifacts directory')
  .requiredOption('-o, --out <path>', 'Output manifest path')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const generator = new ManifestGenerator();
      const buildDir = path.resolve(options.buildDir);
      const outputPath = path.resolve(options.out);

      await generator.generate({
        buildDir,
        outputPath,
        verbose: options.verbose,
      });

      console.log(chalk.green('✅ Manifest generated'));
      console.log(chalk.cyan('📋 Manifest:'), outputPath);
    } catch (error) {
      console.error(
        chalk.red('❌ Manifest generation failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('upload')
  .description('Upload build artifacts to Yandex Cloud Object Storage')
  .requiredOption('-b, --build-dir <dir>', 'Build artifacts directory')
  .requiredOption('--bucket <name>', 'S3 bucket name for assets')
  .option('--region <region>', 'YC region', 'ru-central1')
  .option('--endpoint <url>', 'S3 endpoint URL')
  .option('-v, --verbose', 'Verbose output')
  .option('--dry-run', 'Show what would be uploaded without uploading')
  .action(async (options) => {
    try {
      const uploader = new Uploader();
      const buildDir = path.resolve(options.buildDir);

      await uploader.upload({
        buildDir,
        assetsBucket: options.bucket,
        region: options.region,
        endpoint: options.endpoint,
        verbose: options.verbose,
        dryRun: options.dryRun,
      });

      if (!options.dryRun) {
        console.log(chalk.green('✅ Upload complete'));
      }
    } catch (error) {
      console.error(
        chalk.red('❌ Upload failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('plan')
  .description('Show deployment plan without building or uploading')
  .requiredOption('-p, --project <path>', 'Path to Angular project')
  .option('--project-name <name>', 'Angular project name from angular.json')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const analyzer = new Analyzer();
      const projectPath = path.resolve(options.project);

      const capabilities = await analyzer.analyze({
        projectPath,
        projectName: options.projectName,
        verbose: false,
      });

      console.log(chalk.cyan('\n📋 Deployment Plan'));
      console.log(chalk.gray('─'.repeat(60)));
      console.log(chalk.white('Angular version:'), capabilities.angularVersion);
      console.log(
        chalk.white('Deployment mode:'),
        capabilities.rendering.needsServer ? 'Dynamic SSR/API' : 'Static only',
      );

      console.log(chalk.white('\nComponents:'));
      if (capabilities.rendering.needsServer) {
        console.log(chalk.gray('  • Server function (SSR + Express API routes)'));
      }
      if (capabilities.assets.needsImage) {
        console.log(chalk.gray('  • Image optimization function'));
      }
      console.log(chalk.gray('  • Static assets (Object Storage)'));

      if (capabilities.prerender.enabled) {
        console.log(chalk.white('\nPrerendering:'));
        console.log(chalk.gray(`  • Routes detected: ${capabilities.prerender.routes.length}`));
      }

      if (capabilities.responseCache.enabled) {
        console.log(chalk.white('\nResponse cache:'));
        console.log(
          chalk.gray(
            `  • TTL: ${capabilities.responseCache.defaultTtlSeconds}s (+${capabilities.responseCache.staleWhileRevalidateSeconds}s SWR)`,
          ),
        );
        console.log(chalk.gray(`  • Purge endpoint: ${capabilities.responseCache.purgePath}`));
      }

      if (capabilities.notes.length > 0) {
        console.log(chalk.yellow('\nWarnings:'));
        for (const note of capabilities.notes) {
          console.log(chalk.yellow(`  • ${note}`));
        }
      }

      console.log(chalk.gray('─'.repeat(60)));
      console.log(chalk.green('✅ Plan complete. Run "angular-yc build" to proceed.'));
    } catch (error) {
      console.error(
        chalk.red('❌ Planning failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
