/**
 * @angular-yc/runtime - Runtime adapters for Angular SSR on Yandex Cloud Functions.
 */

export { createServerHandler } from './server-handler.js';
export type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  HandlerOptions,
} from './server-handler.js';

export { createImageHandler } from './image-handler.js';
export type { ImageHandlerOptions } from './image-handler.js';

export { createResponseCache, InMemoryResponseCache } from './response-cache/cache.js';
export type {
  CachedResponse,
  ResponseCache,
  ResponseCacheOptions,
} from './response-cache/cache.js';

export { ResponseCacheYDB } from './response-cache/cache-ydb.js';
export type { ResponseCacheYDBOptions } from './response-cache/cache-ydb.js';

export { verifyPurgeAuthorization } from './response-cache/purge-auth.js';
export type { PurgeAuthConfig, PurgeAuthRequest } from './response-cache/purge-auth.js';
