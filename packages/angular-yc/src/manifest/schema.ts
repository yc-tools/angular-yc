import { z } from 'zod';

export const SSRCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  entrypoint: z.string().optional(),
  expressAdapter: z.enum(['express-app', 'request-handler', 'none']).default('none'),
  standaloneBundle: z.boolean().default(false),
});

export const PrerenderCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  routes: z.array(z.string()).default([]),
  discoveredFrom: z
    .enum(['angular-json', 'routes-file', 'router-analysis', 'none'])
    .default('none'),
});

export const APICapabilitiesSchema = z.object({
  enabled: z.boolean(),
  framework: z.literal('express').default('express'),
  basePath: z.string().default('/api'),
  routesDetected: z.array(z.string()).default([]),
});

export const RenderingCapabilitiesSchema = z.object({
  needsServer: z.boolean(),
  lazyLoading: z.boolean(),
  standalone: z.boolean(),
  hydration: z.object({
    enabled: z.boolean(),
    incremental: z.boolean(),
  }),
  signals: z.object({
    enabled: z.boolean(),
    linkedSignal: z.boolean(),
    resourceApi: z.boolean(),
  }),
  zoneless: z.object({
    enabled: z.boolean(),
    stable: z.boolean(),
  }),
});

export const AssetsCapabilitiesSchema = z.object({
  needsImage: z.boolean(),
  ngOptimizedImage: z.boolean(),
});

export const ResponseCacheCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  defaultTtlSeconds: z.number().int().positive(),
  staleWhileRevalidateSeconds: z.number().int().nonnegative(),
  varyHeaders: z.array(z.string()),
  bypassPaths: z.array(z.string()),
  purgePath: z.string(),
  tagsEnabled: z.boolean(),
});

export const CapabilitiesSchema = z.object({
  angularVersion: z.string(),
  ssr: SSRCapabilitiesSchema,
  prerender: PrerenderCapabilitiesSchema,
  api: APICapabilitiesSchema,
  rendering: RenderingCapabilitiesSchema,
  assets: AssetsCapabilitiesSchema,
  responseCache: ResponseCacheCapabilitiesSchema,
  notes: z.array(z.string()),
});

export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const ArtifactSchema = z.object({
  zipPath: z.string().optional(),
  localDir: z.string().optional(),
  bucketKeyPrefix: z.string().optional(),
  browserDir: z.string().optional(),
  prerenderDir: z.string().optional(),
  entry: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const RoutingSchema = z.object({
  openapiTemplatePath: z.string().optional(),
  openapiInline: z.string().optional(),
  payloadFormat: z.enum(['1.0', '2.0']).default('1.0'),
  staticPaths: z.array(z.string()).default([]),
  prerenderRoutes: z
    .array(
      z.object({
        route: z.string(),
        objectKey: z.string(),
      }),
    )
    .optional(),
  apiBasePath: z.string().default('/api'),
  catchAllPath: z.string().default('/{proxy+}'),
});

export const ResponseCacheConfigSchema = z.object({
  cache: z.object({
    bucketPrefix: z.string(),
  }),
  ydb: z.object({
    tables: z.object({
      entries: z.string(),
      tags: z.string(),
      locks: z.string(),
    }),
    docapiEndpoint: z.string().optional(),
  }),
  revalidate: z.object({
    endpointPath: z.string(),
    auth: z.enum(['hmac', 'ip-whitelist', 'both']),
  }),
});

export const DeployManifestSchema = z.object({
  schemaVersion: z.literal('1.0'),
  buildId: z.string(),
  timestamp: z.string().datetime(),
  angularVersion: z.string(),
  projectName: z.string(),
  capabilities: CapabilitiesSchema,
  routing: RoutingSchema,
  artifacts: z.object({
    assets: ArtifactSchema,
    server: ArtifactSchema.optional(),
    image: ArtifactSchema.optional(),
  }),
  responseCache: ResponseCacheConfigSchema.optional(),
  environment: z
    .object({
      variables: z.record(z.string(), z.string()),
      secrets: z.array(
        z.object({
          name: z.string(),
          lockboxId: z.string().optional(),
          entryKey: z.string().optional(),
        }),
      ),
    })
    .optional(),
  deployment: z.object({
    region: z.string().default('ru-central1'),
    functions: z.object({
      server: z
        .object({
          memory: z.number().default(512),
          timeout: z.number().default(30),
          preparedInstances: z.number().default(0),
        })
        .optional(),
      image: z
        .object({
          memory: z.number().default(256),
          timeout: z.number().default(30),
          preparedInstances: z.number().default(0),
        })
        .optional(),
    }),
  }),
});

export type DeployManifest = z.infer<typeof DeployManifestSchema>;

export function validateManifest(manifest: unknown): DeployManifest {
  return DeployManifestSchema.parse(manifest);
}

export function createDefaultManifest(
  buildId: string,
  projectName: string,
  capabilities: Capabilities,
): DeployManifest {
  const staticPaths = ['/browser/{proxy+}', '/assets/{proxy+}', '/favicon.ico', '/robots.txt'];

  return {
    schemaVersion: '1.0',
    buildId,
    timestamp: new Date().toISOString(),
    angularVersion: capabilities.angularVersion,
    projectName,
    capabilities,
    routing: {
      payloadFormat: '1.0',
      staticPaths,
      apiBasePath: capabilities.api.basePath,
      catchAllPath: '/{proxy+}',
    },
    artifacts: {
      assets: {
        localDir: './artifacts/assets',
        bucketKeyPrefix: '',
        browserDir: './artifacts/assets/browser',
        prerenderDir: capabilities.prerender.enabled ? './artifacts/assets/prerender' : undefined,
      },
      server: capabilities.rendering.needsServer
        ? {
            zipPath: './artifacts/server.zip',
            entry: 'index.handler',
            env: {
              NODE_ENV: 'production',
              YC_ANGULAR_BUILD_ID: buildId,
            },
          }
        : undefined,
      image: capabilities.assets.needsImage
        ? {
            zipPath: './artifacts/image.zip',
            entry: 'image.handler',
            env: {
              NODE_ENV: 'production',
            },
          }
        : undefined,
    },
    responseCache: capabilities.responseCache.enabled
      ? {
          cache: {
            bucketPrefix: '_cache/response',
          },
          ydb: {
            tables: {
              entries: 'response_cache_entries',
              tags: 'response_cache_tags',
              locks: 'response_cache_locks',
            },
          },
          revalidate: {
            endpointPath: capabilities.responseCache.purgePath,
            auth: 'hmac',
          },
        }
      : undefined,
    environment: {
      variables: {},
      secrets: [],
    },
    deployment: {
      region: 'ru-central1',
      functions: {
        server: capabilities.rendering.needsServer
          ? {
              memory: 512,
              timeout: 30,
              preparedInstances: 0,
            }
          : undefined,
        image: capabilities.assets.needsImage
          ? {
              memory: 256,
              timeout: 30,
              preparedInstances: 0,
            }
          : undefined,
      },
    },
  };
}
