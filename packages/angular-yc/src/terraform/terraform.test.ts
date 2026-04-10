import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupTerraformProject,
  extractOutputString,
  migrateLegacyModuleState,
  prepareTerraformProject,
  resolveBackendConfig,
  TerraformRunner,
} from './index.js';

describe('resolveBackendConfig', () => {
  it('returns null when state bucket/key are missing', () => {
    const result = resolveBackendConfig({}, {});
    expect(result).toBeNull();
  });

  it('builds config from input and env', () => {
    const result = resolveBackendConfig(
      {
        stateBucket: 'tf-state',
        stateKey: 'studio/terraform.tfstate',
      },
      {
        YC_REGION: 'ru-central1',
        YC_ACCESS_KEY: 'ak',
        YC_SECRET_KEY: 'sk',
      },
    );

    expect(result).toEqual({
      bucket: 'tf-state',
      key: 'studio/terraform.tfstate',
      region: 'ru-central1',
      endpoint: 'https://storage.yandexcloud.net',
      accessKey: 'ak',
      secretKey: 'sk',
    });
  });

  it('throws when credentials are missing', () => {
    expect(() =>
      resolveBackendConfig(
        {
          stateBucket: 'tf-state',
          stateKey: 'studio/terraform.tfstate',
        },
        {},
      ),
    ).toThrow('Backend credentials are required');
  });
});

describe('extractOutputString', () => {
  it('returns output value when present', () => {
    const value = extractOutputString(
      {
        assets_bucket: {
          value: 'my-assets-bucket',
        },
      },
      'assets_bucket',
    );

    expect(value).toBe('my-assets-bucket');
  });

  it('returns undefined for missing or null-like values', () => {
    expect(extractOutputString({}, 'assets_bucket')).toBeUndefined();
    expect(
      extractOutputString({ assets_bucket: { value: null } }, 'assets_bucket'),
    ).toBeUndefined();
    expect(
      extractOutputString({ assets_bucket: { value: 'null' } }, 'assets_bucket'),
    ).toBeUndefined();
    expect(
      extractOutputString({ assets_bucket: { value: '  ' } }, 'assets_bucket'),
    ).toBeUndefined();
  });
});

describe('prepareTerraformProject', () => {
  it('creates a working directory from embedded terraform template', async () => {
    const terraformDir = await prepareTerraformProject();

    try {
      expect(await fs.pathExists(terraformDir)).toBe(true);
      expect(await fs.pathExists(`${terraformDir}/backend.tf`)).toBe(true);
      expect(await fs.pathExists(`${terraformDir}/main.tf`)).toBe(true);
      expect(await fs.pathExists(`${terraformDir}/providers.tf`)).toBe(true);
      expect(await fs.pathExists(`${terraformDir}/versions.tf`)).toBe(true);
      expect(await fs.pathExists(`${terraformDir}/variables.tf`)).toBe(true);
      expect(await fs.pathExists(`${terraformDir}/outputs.tf`)).toBe(true);
      expect(await fs.pathExists(`${terraformDir}/templates/openapi.yaml.tpl`)).toBe(true);
      expect(await fs.pathExists(`${terraformDir}/modules/core_security/main.tf`)).toBe(true);
    } finally {
      await cleanupTerraformProject(terraformDir);
    }
  });

  it('does not attach tags to function resources to avoid functionTags quota growth', async () => {
    const terraformDir = await prepareTerraformProject();

    try {
      const mainTf = await fs.readFile(`${terraformDir}/main.tf`, 'utf8');
      expect(mainTf).not.toContain('tags = local.common_tags');
      expect(mainTf).not.toContain('common_tags = toset(');
    } finally {
      await cleanupTerraformProject(terraformDir);
    }
  });

  it('ensures function resources wait for IAM role bindings before version creation', async () => {
    const terraformDir = await prepareTerraformProject();

    try {
      const mainTf = await fs.readFile(`${terraformDir}/main.tf`, 'utf8');
      expect(mainTf).toContain(
        'depends_on = [\n' +
          '    yandex_resourcemanager_folder_iam_member.functions_invoker,\n' +
          '    yandex_resourcemanager_folder_iam_member.storage_viewer,\n' +
          '    yandex_resourcemanager_folder_iam_member.storage_editor,\n' +
          '    yandex_resourcemanager_folder_iam_member.lockbox_payload_viewer,\n' +
          '  ]',
      );
    } finally {
      await cleanupTerraformProject(terraformDir);
    }
  });

  it('creates API gateway DNS record for both new and existing DNS zones', async () => {
    const terraformDir = await prepareTerraformProject();

    try {
      const mainTf = await fs.readFile(`${terraformDir}/main.tf`, 'utf8');
      expect(mainTf).toContain(
        'count = (var.create_dns_zone || trimspace(var.dns_zone_id) != "") ? 1 : 0',
      );
      expect(mainTf).toContain(
        'zone_id = var.create_dns_zone ? yandex_dns_zone.main[0].id : var.dns_zone_id',
      );
    } finally {
      await cleanupTerraformProject(terraformDir);
    }
  });

  it('uses x-yc-apigateway-any-method instead of unsupported OpenAPI any operations', async () => {
    const terraformDir = await prepareTerraformProject();

    try {
      const openapiTemplate = await fs.readFile(
        `${terraformDir}/templates/openapi.yaml.tpl`,
        'utf8',
      );
      expect(openapiTemplate).toContain('/api/{proxy+}:\n    x-yc-apigateway-any-method:');
      expect(openapiTemplate).toContain('/{proxy+}:\n    x-yc-apigateway-any-method:');
      expect(openapiTemplate).toContain('/:\n    x-yc-apigateway-any-method:');
      expect(openapiTemplate).not.toContain('\n    any:\n');
      expect(openapiTemplate).not.toContain('function_version_id:');
    } finally {
      await cleanupTerraformProject(terraformDir);
    }
  });

  it('pins API gateway ordering and lets terraform detect spec drift', async () => {
    const terraformDir = await prepareTerraformProject();

    try {
      const mainTf = await fs.readFile(`${terraformDir}/main.tf`, 'utf8');
      expect(mainTf).toContain('depends_on = [');
      expect(mainTf).toContain('yandex_function.server');
      expect(mainTf).toContain('yandex_function.image');
      expect(mainTf).toContain('yandex_dns_recordset.validation');
      // `lifecycle { ignore_changes = [spec] }` used to be here, which caused
      // the deployed openapi spec to drift permanently from the template
      // (e.g. stale `assets/build-<id>/...` object keys after the template
      // was refactored to flat paths). Removed so terraform reconciles
      // spec drift on every apply.
      expect(mainTf).not.toContain('ignore_changes = [spec]');
    } finally {
      await cleanupTerraformProject(terraformDir);
    }
  });
});

describe('migrateLegacyModuleState', () => {
  it('moves known legacy module addresses to current addresses', async () => {
    const moves: Array<[string, string]> = [];
    const runner = {
      listState: vi
        .fn()
        .mockResolvedValue([
          'module.angular_app.yandex_iam_service_account.functions',
          'module.angular_app.module.security.yandex_iam_service_account.api_gateway',
          'module.angular_app.module.security.random_password.storage_access_key',
          'yandex_storage_bucket.assets[0]',
          'module.angular_app.yandex_storage_bucket.assets[0]',
        ]),
      moveState: vi.fn(async (from: string, to: string) => {
        moves.push([from, to]);
      }),
    } as unknown as TerraformRunner;

    await migrateLegacyModuleState({ runner });

    expect(moves).toEqual([
      [
        'module.angular_app.yandex_iam_service_account.functions',
        'yandex_iam_service_account.functions',
      ],
      [
        'module.angular_app.module.security.yandex_iam_service_account.api_gateway',
        'module.security.yandex_iam_service_account.api_gateway',
      ],
    ]);
  });

  it('does nothing when state has no legacy module addresses', async () => {
    const runner = {
      listState: vi.fn().mockResolvedValue(['yandex_iam_service_account.functions']),
      moveState: vi.fn(),
    } as unknown as TerraformRunner;

    await migrateLegacyModuleState({ runner });

    expect(runner.moveState).not.toHaveBeenCalled();
  });
});
