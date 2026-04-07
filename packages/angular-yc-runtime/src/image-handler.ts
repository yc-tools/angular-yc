import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import crypto from 'crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from './server-handler.js';

export interface ImageHandlerOptions {
  cacheBucket?: string;
  sourcesBucket?: string;
  region?: string;
  endpoint?: string;
  maxAge?: number;
  quality?: number;
  formats?: string[];
}

interface ImageParams {
  url: string;
  w?: string;
  q?: string;
}

const AVIF = 'image/avif';
const WEBP = 'image/webp';
const PNG = 'image/png';
const JPEG = 'image/jpeg';
const GIF = 'image/gif';
const SVG = 'image/svg+xml';
const ICO = 'image/x-icon';
let sharpFactory: ((input: Buffer) => any) | undefined;

export function createImageHandler(options: ImageHandlerOptions = {}) {
  const {
    cacheBucket,
    sourcesBucket,
    region = 'ru-central1',
    endpoint = 'https://storage.yandexcloud.net',
    maxAge = 60 * 60 * 24 * 365,
    quality = 75,
    formats = [AVIF, WEBP],
  } = options;

  const s3Client =
    cacheBucket || sourcesBucket
      ? new S3Client({
          region,
          endpoint,
        })
      : null;

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    try {
      const params = parseImageParams(event.rawQueryString || '');

      if (!params.url) {
        return {
          statusCode: 400,
          headers: { 'content-type': 'text/plain' },
          body: 'Missing required parameter: url',
        };
      }

      const width = params.w ? Number.parseInt(params.w, 10) : undefined;
      if (width && (width < 1 || width > 4000)) {
        return {
          statusCode: 400,
          headers: { 'content-type': 'text/plain' },
          body: 'Invalid width parameter',
        };
      }

      const accept = event.headers.accept || '';
      const cacheKey = generateCacheKey(params, accept);

      if (s3Client && cacheBucket) {
        const cached = await getFromCache(s3Client, cacheBucket, cacheKey);
        if (cached) {
          return cached;
        }
      }

      const sourceImage = await fetchSourceImage(params.url, s3Client, sourcesBucket);
      if (!sourceImage) {
        return {
          statusCode: 404,
          headers: { 'content-type': 'text/plain' },
          body: 'Image not found',
        };
      }

      const format = detectFormat(sourceImage.contentType, accept, formats);
      const processed = await processImage(sourceImage.buffer, {
        width,
        quality: params.q ? Number.parseInt(params.q, 10) : quality,
        format,
      });

      const response: APIGatewayProxyResultV2 = {
        statusCode: 200,
        headers: {
          'content-type': processed.format,
          'cache-control': `public, max-age=${maxAge}, immutable`,
          'content-length': String(processed.buffer.length),
        },
        body: processed.buffer.toString('base64'),
        isBase64Encoded: true,
      };

      if (s3Client && cacheBucket) {
        await saveToCache(s3Client, cacheBucket, cacheKey, processed, maxAge);
      }

      return response;
    } catch (error) {
      console.error('[Image] Error:', error);
      return {
        statusCode: 500,
        headers: { 'content-type': 'text/plain' },
        body: 'Internal Server Error',
      };
    }
  };
}

function parseImageParams(queryString: string): ImageParams {
  const params = new URLSearchParams(queryString);
  return {
    url: params.get('url') || '',
    w: params.get('w') || undefined,
    q: params.get('q') || undefined,
  };
}

function generateCacheKey(params: ImageParams, accept: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(params.url);
  hash.update(params.w || '');
  hash.update(params.q || '');
  hash.update(accept);
  return `_cache/images/${hash.digest('hex')}`;
}

async function getFromCache(
  s3Client: S3Client,
  bucket: string,
  key: string,
): Promise<APIGatewayProxyResultV2 | null> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      return null;
    }

    const buffer = await streamToBuffer(response.Body as Readable);

    return {
      statusCode: 200,
      headers: {
        'content-type': response.ContentType || JPEG,
        'cache-control': response.CacheControl || 'public, max-age=31536000',
        'content-length': String(buffer.length),
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    const err = error as { Code?: string };
    if (err.Code !== 'NoSuchKey') {
      console.error('[Image] Cache read error:', error);
    }
    return null;
  }
}

async function saveToCache(
  s3Client: S3Client,
  bucket: string,
  key: string,
  processed: { buffer: Buffer; format: string },
  maxAge: number,
): Promise<void> {
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: processed.buffer,
        ContentType: processed.format,
        CacheControl: `public, max-age=${maxAge}`,
      }),
    );
  } catch (error) {
    console.error('[Image] Cache write error:', error);
  }
}

async function fetchSourceImage(
  url: string,
  s3Client: S3Client | null,
  sourcesBucket?: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    if (url.startsWith('/') && s3Client && sourcesBucket) {
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: sourcesBucket,
          Key: url.substring(1),
        }),
      );

      if (!response.Body) {
        return null;
      }

      return {
        buffer: await streamToBuffer(response.Body as Readable),
        contentType: response.ContentType || JPEG,
      };
    }

    if (url.startsWith('http://') || url.startsWith('https://')) {
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || JPEG;

      return { buffer, contentType };
    }

    return null;
  } catch (error) {
    console.error('[Image] Source fetch error:', error);
    return null;
  }
}

async function processImage(
  input: Buffer,
  options: {
    width?: number;
    quality: number;
    format: string;
  },
): Promise<{ buffer: Buffer; format: string }> {
  const sharp = await loadSharp();
  let pipeline = sharp(input);

  if (options.width) {
    pipeline = pipeline.resize(options.width, null, {
      withoutEnlargement: true,
      fit: 'inside',
    });
  }

  switch (options.format) {
    case AVIF:
      pipeline = pipeline.avif({ quality: options.quality });
      break;
    case WEBP:
      pipeline = pipeline.webp({ quality: options.quality });
      break;
    case PNG:
      pipeline = pipeline.png({ quality: options.quality });
      break;
    case JPEG:
    default:
      pipeline = pipeline.jpeg({ quality: options.quality });
      break;
  }

  const buffer = await pipeline.toBuffer();
  return { buffer, format: options.format };
}

async function loadSharp(): Promise<(input: Buffer) => any> {
  if (sharpFactory) {
    return sharpFactory;
  }

  try {
    const module = await import('sharp');
    const sharpExport = module.default;
    if (typeof sharpExport !== 'function') {
      throw new Error('sharp default export is not a function');
    }
    sharpFactory = sharpExport as (input: Buffer) => any;
    return sharpFactory;
  } catch (error) {
    throw new Error(
      `Image optimization dependency "sharp" is not available: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function detectFormat(sourceType: string, accept: string, supportedFormats: string[]): string {
  if (sourceType === SVG || sourceType === ICO) {
    return sourceType;
  }

  if (accept.includes(AVIF) && supportedFormats.includes(AVIF)) {
    return AVIF;
  }

  if (accept.includes(WEBP) && supportedFormats.includes(WEBP)) {
    return WEBP;
  }

  return sourceType === PNG || sourceType === GIF ? PNG : JPEG;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
