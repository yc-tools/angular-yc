import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

export interface TerraformBackendConfig {
  bucket: string;
  key: string;
  region: string;
  endpoint: string;
  accessKey: string;
  secretKey: string;
}

export interface TerraformRunOptions {
  captureOutput?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface TerraformApplyOptions {
  targets?: string[];
  replace?: string[];
  autoApprove?: boolean;
  refresh?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface TerraformOutputEntry {
  sensitive?: boolean;
  type?: unknown;
  value: unknown;
}

export interface TerraformBackendInput {
  stateBucket?: string;
  stateKey?: string;
  stateRegion?: string;
  stateEndpoint?: string;
  stateAccessKey?: string;
  stateSecretKey?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERRAFORM_TEMPLATE_DIR = path.join(__dirname, 'project');
const LEGACY_APP_MODULE_PREFIX = 'module.angular_app.';
const LEGACY_SECURITY_PREFIX = `${LEGACY_APP_MODULE_PREFIX}module.security.`;
const REMOVED_SECURITY_SUFFIX_PREFIXES = [
  'random_password.storage_access_key',
  'random_password.storage_secret_key',
  'yandex_lockbox_secret.storage_keys',
  'yandex_lockbox_secret_version.storage_keys',
  'yandex_iam_service_account_static_access_key.storage',
  'yandex_lockbox_secret.storage_sa_keys',
  'yandex_lockbox_secret_version.storage_sa_keys',
];

export function resolveBackendConfig(
  input: TerraformBackendInput,
  env: NodeJS.ProcessEnv = process.env,
): TerraformBackendConfig | null {
  const bucket = input.stateBucket || env.TF_STATE_BUCKET || '';
  const key = input.stateKey || env.TF_STATE_KEY || '';

  if (!bucket || !key) {
    return null;
  }

  const region = input.stateRegion || env.YC_REGION || 'ru-central1';
  const endpoint =
    input.stateEndpoint || env.TF_STATE_ENDPOINT || 'https://storage.yandexcloud.net';
  const accessKey = input.stateAccessKey || env.YC_ACCESS_KEY || env.AWS_ACCESS_KEY_ID || '';
  const secretKey = input.stateSecretKey || env.YC_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY || '';

  if (!accessKey || !secretKey) {
    throw new Error(
      'Backend credentials are required: provide YC_ACCESS_KEY/YC_SECRET_KEY (or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY).',
    );
  }

  return {
    bucket,
    key,
    region,
    endpoint,
    accessKey,
    secretKey,
  };
}

export function extractOutputString(
  outputs: Record<string, TerraformOutputEntry>,
  key: string,
): string | undefined {
  const entry = outputs[key];
  if (!entry) {
    return undefined;
  }

  if (entry.value === null || entry.value === undefined) {
    return undefined;
  }

  const value = String(entry.value).trim();
  if (value === '' || value === 'null') {
    return undefined;
  }

  return value;
}

export async function prepareTerraformProject(): Promise<string> {
  if (!(await fs.pathExists(TERRAFORM_TEMPLATE_DIR))) {
    throw new Error(`Embedded terraform template not found: ${TERRAFORM_TEMPLATE_DIR}`);
  }

  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'angular-yc-terraform-'));
  await fs.copy(TERRAFORM_TEMPLATE_DIR, workingDir);
  return workingDir;
}

export async function cleanupTerraformProject(terraformDir: string): Promise<void> {
  await fs.remove(terraformDir);
}

function mapLegacyAddress(address: string): string | undefined {
  if (address.startsWith(LEGACY_SECURITY_PREFIX)) {
    const suffix = address.slice(LEGACY_SECURITY_PREFIX.length);

    if (suffix.startsWith('data.')) {
      return undefined;
    }

    if (
      REMOVED_SECURITY_SUFFIX_PREFIXES.some(
        (prefix) => suffix === prefix || suffix.startsWith(`${prefix}[`),
      )
    ) {
      return undefined;
    }

    return `module.security.${suffix}`;
  }

  if (!address.startsWith(LEGACY_APP_MODULE_PREFIX)) {
    return undefined;
  }

  const suffix = address.slice(LEGACY_APP_MODULE_PREFIX.length);
  if (suffix.startsWith('data.')) {
    return undefined;
  }

  return suffix;
}

export async function migrateLegacyModuleState(options: {
  runner: TerraformRunner;
  env?: NodeJS.ProcessEnv;
  verbose?: boolean;
}): Promise<void> {
  const stateAddresses = await options.runner.listState(options.env);
  if (!stateAddresses.some((address) => address.startsWith(LEGACY_APP_MODULE_PREFIX))) {
    return;
  }

  const knownAddresses = new Set(stateAddresses);
  const moves: Array<{ from: string; to: string }> = [];

  for (const from of stateAddresses) {
    const to = mapLegacyAddress(from);
    if (!to || knownAddresses.has(to)) {
      continue;
    }

    moves.push({ from, to });
  }

  if (moves.length === 0) {
    return;
  }

  for (const move of moves) {
    await options.runner.moveState(move.from, move.to, options.env);
    knownAddresses.delete(move.from);
    knownAddresses.add(move.to);

    if (options.verbose) {
      console.log(`↪️  Migrated terraform state: ${move.from} -> ${move.to}`);
    }
  }
}

export class TerraformRunner {
  constructor(
    private readonly terraformDir: string,
    private readonly terraformBin: string = 'terraform',
  ) {}

  async init(backend?: TerraformBackendConfig, env?: NodeJS.ProcessEnv): Promise<void> {
    const args = ['init'];

    if (backend) {
      args.push(`-backend-config=bucket=${backend.bucket}`);
      args.push(`-backend-config=key=${backend.key}`);
      args.push(`-backend-config=region=${backend.region}`);
      args.push(`-backend-config=endpoint=${backend.endpoint}`);
      args.push('-backend-config=skip_region_validation=true');
      args.push('-backend-config=skip_credentials_validation=true');
      args.push('-backend-config=skip_metadata_api_check=true');
      args.push('-backend-config=skip_requesting_account_id=true');
      args.push(`-backend-config=access_key=${backend.accessKey}`);
      args.push(`-backend-config=secret_key=${backend.secretKey}`);
    }

    await this.run(args, { env });
  }

  async apply(options: TerraformApplyOptions = {}): Promise<void> {
    const args = ['apply'];

    if (options.autoApprove) {
      args.push('-auto-approve');
    }

    if (options.refresh === false) {
      args.push('-refresh=false');
    }

    for (const target of options.targets || []) {
      args.push(`-target=${target}`);
    }

    for (const replaceTarget of options.replace || []) {
      args.push(`-replace=${replaceTarget}`);
    }

    await this.run(args, { env: options.env });
  }

  async readOutputs(env?: NodeJS.ProcessEnv): Promise<Record<string, TerraformOutputEntry>> {
    try {
      const { stdout } = await this.run(['output', '-json'], {
        captureOutput: true,
        env,
      });

      if (!stdout.trim()) {
        return {};
      }

      return JSON.parse(stdout) as Record<string, TerraformOutputEntry>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('No outputs found') ||
        message.includes('state file either has no outputs defined')
      ) {
        return {};
      }
      throw error;
    }
  }

  async listState(env?: NodeJS.ProcessEnv): Promise<string[]> {
    try {
      const { stdout } = await this.run(['state', 'list'], {
        captureOutput: true,
        env,
      });

      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('No state file was found') ||
        message.includes('state file either has no resources')
      ) {
        return [];
      }

      throw error;
    }
  }

  async moveState(from: string, to: string, env?: NodeJS.ProcessEnv): Promise<void> {
    if (from === to) {
      return;
    }

    await this.run(['state', 'mv', from, to], { env });
  }

  private async run(
    args: string[],
    options: TerraformRunOptions = {},
  ): Promise<{
    stdout: string;
    stderr: string;
  }> {
    const captureOutput = options.captureOutput ?? false;
    const MAX_CAPTURED_OUTPUT = 256 * 1024;

    return new Promise((resolve, reject) => {
      const child = spawn(this.terraformBin, args, {
        cwd: this.terraformDir,
        env: { ...process.env, ...options.env },
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';

      const appendOutput = (current: string, chunk: Buffer | string): string => {
        const next = current + String(chunk);
        if (next.length <= MAX_CAPTURED_OUTPUT) {
          return next;
        }
        return next.slice(-MAX_CAPTURED_OUTPUT);
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = appendOutput(stdout, chunk);
        if (!captureOutput) {
          process.stdout.write(chunk);
        }
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = appendOutput(stderr, chunk);
        if (!captureOutput) {
          process.stderr.write(chunk);
        }
      });

      child.on('error', (err: Error) => reject(err));
      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const command = [this.terraformBin, ...args].join(' ');
        reject(new Error(`Command failed (${code}): ${command}\n${stderr || stdout}`));
      });
    });
  }
}
