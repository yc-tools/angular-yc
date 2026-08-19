import { IncomingMessage, ServerResponse } from 'http';
import { PassThrough } from 'stream';
import path from 'path';
import fs from 'fs';

const DEBUG = Boolean(process.env.AYC_DEBUG);

/** Default safety timeout for user handlers: slightly under the typical 60s function timeout. */
const DEFAULT_HANDLER_TIMEOUT_MS = 55_000;

/** Verbose diagnostics, enabled via AYC_DEBUG. */
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

/* ------------------------------------------------------------------ */
/*  Yandex Cloud Functions event / response types                     */
/* ------------------------------------------------------------------ */

export interface APIGatewayProxyEventV2 {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  cookies?: string[];
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    domainPrefix: string;
    http: {
      method: string;
      path: string;
      protocol: string;
      sourceIp: string;
      userAgent: string;
    };
    requestId: string;
    routeKey: string;
    stage: string;
    time: string;
    timeEpoch: number;
  };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface APIGatewayProxyResultV2 {
  statusCode: number;
  headers?: Record<string, string | number | boolean>;
  multiValueHeaders?: Record<string, Array<string | number | boolean>>;
  body?: string;
  isBase64Encoded?: boolean;
  cookies?: string[];
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export interface HandlerOptions {
  dir: string;
  trustProxy?: boolean;
  handlerExportName?: string;
  serverModuleCandidates?: string[];
  /** @deprecated Caching is temporarily disabled while handler is simplified. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responseCache?: any;
}

type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

interface AngularEngine {
  handle(request: Request): Promise<Response | null>;
}

export function createServerHandler(options: HandlerOptions) {
  const {
    dir,
    trustProxy = true,
    handlerExportName,
    serverModuleCandidates = [
      'server/server.mjs',
      'server/server.js',
      'server/main.server.mjs',
      'server/main.server.js',
      'server.mjs',
      'server.js',
      'server/index.mjs',
      'server/index.js',
      'server/main.mjs',
      'server/main.js',
      'main.server.mjs',
      'main.server.js',
    ],
  } = options;

  let engine: AngularEngine | null = null;
  let nodeHandler: NodeRequestHandler | null = null;

  const initialize = async (): Promise<void> => {
    if (engine || nodeHandler) {
      debugLog('[Server] Already initialized, skipping');
      return;
    }

    const initStart = Date.now();
    const modulePath = resolveServerModule(dir, serverModuleCandidates);
    debugLog(`[Server] Loading module: ${modulePath}`);
    const imported = await import(modulePath);
    debugLog(
      `[Server] Module loaded (+${Date.now() - initStart}ms), exports: ${Object.keys(imported).join(', ')}`,
    );

    // Prefer AngularAppEngine — works with Web Request/Response, no Node shim needed.
    const EngineClass = imported.AngularAppEngine;
    if (typeof EngineClass === 'function') {
      try {
        engine = new EngineClass() as AngularEngine;
        debugLog(`[Server] AngularAppEngine instantiated (+${Date.now() - initStart}ms)`);
      } catch (err) {
        console.error('[Server] AngularAppEngine instantiation failed, falling back to Node:', err);
      }
    } else {
      debugLog('[Server] No AngularAppEngine export found, will use Node handler');
    }

    // Node handler as fallback (API routes, or full Express app if no engine).
    const candidate =
      (handlerExportName ? imported[handlerExportName] : undefined) ||
      imported.reqHandler ||
      imported.app ||
      imported.handler ||
      imported.default ||
      imported.render;

    if (candidate) {
      nodeHandler = normalizeNodeHandler(candidate);
      debugLog(`[Server] Node handler resolved (type: ${typeof candidate})`);
    } else {
      debugLog('[Server] No Node handler found');
    }

    debugLog(
      `[Server] Init complete (+${Date.now() - initStart}ms): engine=${!!engine}, nodeHandler=${!!nodeHandler}`,
    );

    if (!engine && !nodeHandler) {
      throw new Error(`Could not find a usable server export in ${modulePath}`);
    }
  };

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const startTime = Date.now();
    const method = event.requestContext?.http?.method || 'GET';
    const urlPath = event.rawPath || '/';
    const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
    const requestId = event.requestContext?.requestId || 'unknown';

    // One concise summary line per request; everything else is AYC_DEBUG-only.
    const logSummary = (statusCode: number): void => {
      console.log(`[Server] ${method} ${urlPath} ${statusCode} ${Date.now() - startTime}ms`);
    };

    debugLog(`[Server] --> ${method} ${urlPath}${qs} (reqId: ${requestId})`);
    debugLog(`[Server] Headers: ${JSON.stringify(event.headers)}`);

    try {
      await initialize();
      debugLog(`[Server] Initialized (+${Date.now() - startTime}ms)`);

      // Primary: Node handler (Express app with AngularNodeAppEngine).
      // Handles SSR, static files, and API routes with full middleware.
      if (nodeHandler) {
        debugLog(`[Server] Routing to Node handler`);
        const result = await handleViaNode(nodeHandler, event, trustProxy);
        debugLog(
          `[Server] <-- ${result.statusCode} ${method} ${urlPath} (body: ${result.body?.length ?? 0} bytes, +${Date.now() - startTime}ms)`,
        );
        logSummary(result.statusCode);
        return result;
      }

      // Fallback: AngularAppEngine directly (no Express, limited SSR).
      if (engine) {
        const webRequest = buildWebRequest(event, trustProxy);
        debugLog(`[Server] Calling engine.handle() for ${webRequest.url}`);

        const ssrStart = Date.now();
        const response = await engine.handle(webRequest);
        debugLog(
          `[Server] engine.handle() returned: ${response ? response.status : 'null'} (+${Date.now() - ssrStart}ms SSR, +${Date.now() - startTime}ms total)`,
        );

        if (response) {
          const result = await toYCResponse(response);
          debugLog(
            `[Server] <-- ${result.statusCode} ${method} ${urlPath} (body: ${result.body?.length ?? 0} bytes, +${Date.now() - startTime}ms)`,
          );
          logSummary(result.statusCode);
          return result;
        }

        debugLog(`[Server] Engine returned null`);
      }

      logSummary(404);
      return {
        statusCode: 404,
        headers: { 'content-type': 'text/plain' },
        body: 'Not Found',
        isBase64Encoded: false,
      };
    } catch (error) {
      console.error(
        `[Server] <-- 500 ${method} ${urlPath} (+${Date.now() - startTime}ms) Error:`,
        error,
      );
      return {
        statusCode: 500,
        headers: { 'content-type': 'text/plain' },
        body: 'Internal Server Error',
        isBase64Encoded: false,
      };
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Web Request / Response helpers                                    */
/* ------------------------------------------------------------------ */

function buildWebRequest(event: APIGatewayProxyEventV2, trustProxy: boolean): Request {
  const headers = event.headers ?? {};

  const host = trustProxy
    ? headers['x-forwarded-host'] || headers['host'] || 'localhost'
    : headers['host'] || 'localhost';

  const proto = trustProxy ? headers['x-forwarded-proto'] || 'https' : 'https';

  const urlPath = event.rawPath || '/';
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `${proto}://${host}${urlPath}${qs}`;

  debugLog(
    `[Server] buildWebRequest: url=${url}, host=${host}, proto=${proto}, trustProxy=${trustProxy}`,
  );

  const reqHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) reqHeaders.set(key, value);
  }
  if (event.cookies?.length) {
    reqHeaders.set('cookie', event.cookies.join('; '));
  }

  const method = event.requestContext.http.method;
  const hasBody = !['GET', 'HEAD'].includes(method) && event.body;

  let body: string | Buffer | undefined;
  if (hasBody) {
    body = event.isBase64Encoded ? Buffer.from(event.body!, 'base64') : event.body!;
    debugLog(
      `[Server] buildWebRequest: body present (${typeof body === 'string' ? body.length : body.length} bytes, base64=${event.isBase64Encoded})`,
    );
  }

  return new Request(url, { method, headers: reqHeaders, body });
}

async function toYCResponse(response: Response): Promise<APIGatewayProxyResultV2> {
  const responseHeaders: Record<string, string> = {};
  const cookies: string[] = [];

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      cookies.push(value);
    } else {
      responseHeaders[key] = value;
    }
  });

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const contentType = responseHeaders['content-type'] || '';
  const isBase64 = shouldBase64Encode(contentType);

  const result: APIGatewayProxyResultV2 = {
    statusCode: response.status,
    headers: responseHeaders,
    body: isBase64 ? buffer.toString('base64') : buffer.toString('utf-8'),
    isBase64Encoded: isBase64,
  };

  if (cookies.length > 0) {
    result.cookies = cookies;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Node.js fallback (API routes / legacy handlers)                   */
/* ------------------------------------------------------------------ */

function handleViaNode(
  handler: NodeRequestHandler,
  event: APIGatewayProxyEventV2,
  trustProxy: boolean,
): Promise<APIGatewayProxyResultV2> {
  const nodeStart = Date.now();
  debugLog(
    `[Server:Node] Starting handler for ${event.requestContext.http.method} ${event.rawPath}`,
  );

  return new Promise((promiseResolve, promiseReject) => {
    // Safety net: a user handler that neither ends the response nor errors
    // would otherwise leave this promise pending until the function times out
    // with no diagnostics.
    const timeoutMs = Number(process.env.AYC_HANDLER_TIMEOUT_MS) || DEFAULT_HANDLER_TIMEOUT_MS;

    const resolve = (value: APIGatewayProxyResultV2): void => {
      clearTimeout(timeout);
      promiseResolve(value);
    };
    const reject = (reason: unknown): void => {
      clearTimeout(timeout);
      promiseReject(reason);
    };

    const timeout = setTimeout(() => {
      reject(
        new Error(
          `[Server:Node] Handler did not settle within ${timeoutMs}ms for ` +
            `${event.requestContext.http.method} ${event.rawPath}: the server handler neither ` +
            'ended the response nor raised an error. Tune AYC_HANDLER_TIMEOUT_MS if the ' +
            'handler legitimately needs more time.',
        ),
      );
    }, timeoutMs);

    const req = new IncomingMessage(null as never);
    req.method = event.requestContext.http.method;
    req.url = event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : '');

    req.headers = {};
    for (const [key, value] of Object.entries(event.headers || {})) {
      if (value !== undefined) req.headers[key.toLowerCase()] = value;
    }
    if (event.cookies?.length) {
      req.headers.cookie = event.cookies.join('; ');
    }

    const ip =
      trustProxy && req.headers['x-forwarded-for']
        ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
        : event.requestContext.http.sourceIp;

    const socket = new PassThrough() as PassThrough & { remoteAddress?: string };
    socket.remoteAddress = ip;
    Object.defineProperty(req, 'socket', { value: socket, writable: true });

    const chunks: Buffer[] = [];
    const resHeaders: Record<string, string | string[]> = {};
    let statusCode = 200;

    const res = new ServerResponse(req);

    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = function (code: number, ...args: unknown[]) {
      statusCode = code;
      debugLog(`[Server:Node] writeHead(${code}) (+${Date.now() - nodeStart}ms)`);
      return origWriteHead(code, ...(args as []));
    };

    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = function (name: string, value: number | string | readonly string[]) {
      const v = Array.isArray(value) ? value.map(String) : String(value);
      resHeaders[name.toLowerCase()] = v;
      return origSetHeader(name, v);
    };

    // Do NOT delegate to the real res.write / res.end.
    // ServerResponse without a socket returns false (backpressure) from write(),
    // which causes Express to pause file streams and wait for a 'drain' event
    // that never fires — resulting in a 30 s timeout for any large static asset.
    res.write = function (chunk: unknown) {
      if (chunk) {
        const buf = toBuffer(chunk);
        chunks.push(buf);
        debugLog(`[Server:Node] write(${buf.length} bytes) (+${Date.now() - nodeStart}ms)`);
      }
      return true; // No backpressure — buffering in memory.
    } as typeof res.write;

    res.end = function (chunk?: unknown) {
      if (chunk) chunks.push(toBuffer(chunk));

      const body = Buffer.concat(chunks);
      const ct = resHeaders['content-type'];
      const isBase64 = shouldBase64Encode(Array.isArray(ct) ? ct[0] : ct);

      // Express sets res.statusCode directly (e.g. res.status(400)) without
      // calling writeHead(). Since our end() override skips the original
      // ServerResponse.end(), the implicit writeHead() never fires.
      // Read res.statusCode as the authoritative source.
      const finalStatusCode = res.statusCode || statusCode;

      debugLog(
        `[Server:Node] end() status=${finalStatusCode}, body=${body.length} bytes, content-type=${ct || 'none'} (+${Date.now() - nodeStart}ms)`,
      );

      const result: APIGatewayProxyResultV2 = {
        statusCode: finalStatusCode,
        headers: {},
        body: isBase64 ? body.toString('base64') : body.toString('utf-8'),
        isBase64Encoded: isBase64,
      };

      for (const [key, value] of Object.entries(resHeaders)) {
        if (Array.isArray(value)) {
          result.multiValueHeaders = result.multiValueHeaders || {};
          result.multiValueHeaders[key] = value;
        } else {
          result.headers![key] = value;
        }
      }

      const setCookie = resHeaders['set-cookie'];
      if (setCookie) {
        result.cookies = Array.isArray(setCookie) ? setCookie.map(String) : [String(setCookie)];
      }

      resolve(result);
      return res;
    } as typeof res.end;

    res.on('error', (err) => {
      console.error(
        `[Server:Node] res error: ${err?.message || err} (+${Date.now() - nodeStart}ms)`,
      );
      reject(err);
    });

    // Push body into the Readable stream's internal buffer synchronously.
    // Using push() instead of emit('data') avoids a race condition:
    // queueMicrotask fires before async middleware (e.g. store.ready())
    // yields back to express.json(), so the events would be lost.
    // With push(), data is buffered and delivered when express.json()
    // later attaches its 'data' listener.
    if (event.body) {
      const buf = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : Buffer.from(event.body, 'utf-8');
      debugLog(`[Server:Node] Pushing body (${buf.length} bytes)`);
      req.push(buf);
      req.push(null);
    } else {
      req.push(null);
    }

    debugLog(`[Server:Node] Calling handler function...`);
    const maybePromise = handler(req, res);
    if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
      debugLog(`[Server:Node] Handler returned a promise`);
      (maybePromise as Promise<unknown>).catch((err) => {
        console.error(
          `[Server:Node] Handler promise rejected: ${err?.message || err} (+${Date.now() - nodeStart}ms)`,
        );
        reject(err);
      });
    } else {
      debugLog(`[Server:Node] Handler returned synchronously`);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Shared utilities                                                  */
/* ------------------------------------------------------------------ */

function resolveServerModule(dir: string, candidates: string[]): string {
  for (const candidate of candidates) {
    const fullPath = path.resolve(dir, candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  throw new Error(`Could not resolve Angular SSR server module in ${dir}`);
}

function normalizeNodeHandler(candidate: unknown): NodeRequestHandler {
  if (typeof candidate === 'function') return candidate as NodeRequestHandler;

  if (candidate && typeof candidate === 'object' && 'handle' in candidate) {
    const handle = (candidate as { handle: NodeRequestHandler }).handle;
    if (typeof handle === 'function') return handle.bind(candidate);
  }

  throw new Error(
    'Unsupported server export shape. Expected function or object with handle(req,res).',
  );
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function shouldBase64Encode(contentType?: string): boolean {
  if (!contentType) return false;
  const textTypes = [
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-www-form-urlencoded',
  ];
  return !textTypes.some((type) => contentType.includes(type));
}
