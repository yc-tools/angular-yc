import crypto from 'crypto';
import net from 'net';

export interface PurgeAuthRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
  body?: string;
  ip?: string;
}

export interface PurgeAuthConfig {
  mode: 'hmac' | 'ip-whitelist' | 'both';
  secret?: string;
  allowedCidrs?: string[];
  maxSkewSeconds?: number;
}

export interface PurgeAuthResult {
  ok: boolean;
  reason?: string;
}

export function verifyPurgeAuthorization(
  request: PurgeAuthRequest,
  config: PurgeAuthConfig,
): PurgeAuthResult {
  const hmacRequired = config.mode === 'hmac' || config.mode === 'both';
  const ipRequired = config.mode === 'ip-whitelist' || config.mode === 'both';

  if (hmacRequired) {
    const hmacResult = verifyHmac(request, config);
    if (!hmacResult.ok) {
      return hmacResult;
    }
  }

  if (ipRequired) {
    const ipResult = verifyIpWhitelist(request.ip, config.allowedCidrs || []);
    if (!ipResult.ok) {
      return ipResult;
    }
  }

  return { ok: true };
}

function verifyHmac(request: PurgeAuthRequest, config: PurgeAuthConfig): PurgeAuthResult {
  if (!config.secret) {
    return { ok: false, reason: 'missing hmac secret' };
  }

  const signature =
    request.headers['x-yc-signature'] || request.query?.signature || request.headers['x-signature'];
  const timestamp =
    request.headers['x-yc-timestamp'] || request.query?.timestamp || request.headers['x-timestamp'];

  if (!signature || !timestamp) {
    return { ok: false, reason: 'missing signature or timestamp' };
  }

  const timestampNum = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampNum)) {
    return { ok: false, reason: 'invalid timestamp' };
  }

  const maxSkewSeconds = config.maxSkewSeconds ?? 300;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampNum) > maxSkewSeconds) {
    return { ok: false, reason: 'timestamp outside allowed skew' };
  }

  const bodyHash = crypto
    .createHash('sha256')
    .update(request.body || '')
    .digest('hex');
  const canonical = `${request.method.toUpperCase()}\n${request.path}\n${timestamp}\n${bodyHash}`;
  const expected = crypto.createHmac('sha256', config.secret).update(canonical).digest('hex');

  if (!timingSafeEqual(signature, expected)) {
    return { ok: false, reason: 'invalid hmac signature' };
  }

  return { ok: true };
}

function verifyIpWhitelist(ip: string | undefined, cidrs: string[]): PurgeAuthResult {
  if (!ip) {
    return { ok: false, reason: 'missing source ip' };
  }

  if (cidrs.length === 0) {
    return { ok: false, reason: 'ip whitelist is empty' };
  }

  const normalizedIp = ip.split(',')[0].trim();

  for (const cidr of cidrs) {
    if (ipMatchesCidr(normalizedIp, cidr)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'source ip is not allowed' };
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) {
    return ip === cidr;
  }

  const [baseIp, prefixRaw] = cidr.split('/');
  const prefix = Number.parseInt(prefixRaw || '', 10);

  if (net.isIP(ip) !== 4 || net.isIP(baseIp) !== 4) {
    return false;
  }

  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const ipNum = ipv4ToInt(ip);
  const baseNum = ipv4ToInt(baseIp);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;

  return (ipNum & mask) === (baseNum & mask);
}

function ipv4ToInt(ip: string): number {
  return ip
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .reduce((acc, part) => ((acc << 8) | (part & 0xff)) >>> 0, 0);
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);

  if (aBuf.length !== bBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}
