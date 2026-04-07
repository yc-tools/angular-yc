import {
  Driver,
  getSACredentialsFromJson,
  IamAuthService,
  StaticCredentialsAuthService,
  MetadataAuthService,
  TableDescription,
  Column,
  Types,
  TypedValues,
  type Session,
} from 'ydb-sdk';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import crypto from 'crypto';
import { CachedResponse, ResponseCache } from './cache.js';

export interface ResponseCacheYDBOptions {
  region?: string;
  s3Endpoint?: string;
  ydbEndpoint: string;
  ydbDatabase: string;
  cacheBucket: string;
  tablesPrefix?: string;
  buildId: string;
  ydbAccessKeyId?: string;
  ydbSecretAccessKey?: string;
  ydbServiceAccountJson?: string;
  defaultTtlSeconds?: number;
}

export class ResponseCacheYDB implements ResponseCache {
  private readonly s3Client: S3Client;
  private readonly cacheBucket: string;
  private readonly buildId: string;
  private readonly tablesPrefix: string;
  private readonly ydbEndpoint: string;
  private readonly ydbDatabase: string;
  private readonly defaultTtlSeconds: number;
  private readonly ydbCredentials?: {
    type: 'service-account' | 'access-key';
    json?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };

  private ydbDriver: Driver | null = null;

  constructor(options: ResponseCacheYDBOptions) {
    const {
      region = 'ru-central1',
      s3Endpoint = 'https://storage.yandexcloud.net',
      ydbEndpoint,
      ydbDatabase,
      cacheBucket,
      tablesPrefix = 'response_cache',
      buildId,
      ydbAccessKeyId,
      ydbSecretAccessKey,
      ydbServiceAccountJson,
      defaultTtlSeconds = 60,
    } = options;

    this.cacheBucket = cacheBucket;
    this.buildId = buildId;
    this.tablesPrefix = tablesPrefix;
    this.ydbEndpoint = ydbEndpoint;
    this.ydbDatabase = ydbDatabase;
    this.defaultTtlSeconds = defaultTtlSeconds;

    this.s3Client = new S3Client({
      region,
      endpoint: s3Endpoint,
    });

    if (ydbServiceAccountJson) {
      this.ydbCredentials = { type: 'service-account', json: ydbServiceAccountJson };
    } else if (ydbAccessKeyId && ydbSecretAccessKey) {
      this.ydbCredentials = {
        type: 'access-key',
        accessKeyId: ydbAccessKeyId,
        secretAccessKey: ydbSecretAccessKey,
      };
    }
  }

  async get(key: string): Promise<CachedResponse | null> {
    try {
      await this.initYDB();

      const metadata = await this.getMetadataFromYDB(key);
      if (!metadata) {
        return null;
      }

      if (Date.now() > metadata.expiresAt) {
        await this.delete(key);
        return null;
      }

      let body = metadata.body;
      let isBase64Encoded = false;

      if (metadata.hasBody) {
        const s3Key = this.getS3Key(key);
        const response = await this.s3Client.send(
          new GetObjectCommand({
            Bucket: this.cacheBucket,
            Key: s3Key,
          }),
        );

        if (!response.Body) {
          return null;
        }

        const buffer = await streamToBuffer(response.Body as Readable);
        body = buffer.toString('base64');
        isBase64Encoded = true;
      }

      return {
        statusCode: metadata.statusCode,
        headers: metadata.headers || {},
        body,
        isBase64Encoded,
        expiresAt: metadata.expiresAt,
        tags: metadata.tags,
      };
    } catch (error) {
      console.error('[ResponseCache] get() failed:', error);
      return null;
    }
  }

  async set(
    key: string,
    response: CachedResponse,
    options?: {
      ttlSeconds?: number;
      tags?: string[];
    },
  ): Promise<void> {
    await this.initYDB();

    const ttlSeconds = options?.ttlSeconds ?? this.defaultTtlSeconds;
    const expiresAt = Date.now() + ttlSeconds * 1000;

    const metadata = {
      statusCode: response.statusCode,
      headers: response.headers,
      hasBody: true,
      body: '',
      expiresAt,
      tags: options?.tags || response.tags || [],
      updatedAt: Date.now(),
    };

    const bodyBuffer = response.isBase64Encoded
      ? Buffer.from(response.body, 'base64')
      : Buffer.from(response.body, 'utf-8');

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.cacheBucket,
        Key: this.getS3Key(key),
        Body: bodyBuffer,
        ContentType: response.headers['content-type'] || 'text/html',
      }),
    );

    await this.setMetadataInYDB(key, metadata, ttlSeconds);
    if (metadata.tags.length > 0) {
      await this.setTagsInYDB(key, metadata.tags, ttlSeconds);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.initYDB();
      await this.deleteFromYDB(key);
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.cacheBucket,
          Key: this.getS3Key(key),
        }),
      );
    } catch (error) {
      console.error('[ResponseCache] delete() failed:', error);
      throw error;
    }
  }

  async purgeTag(tag: string): Promise<void> {
    await this.initYDB();

    if (!this.ydbDriver) {
      throw new Error('YDB driver not initialized');
    }

    await this.ydbDriver.tableClient.withSession(async (session: Session) => {
      const query = `
        DECLARE $tag AS Utf8;

        SELECT cache_key
        FROM \`${this.tablesPrefix}_tags\`
        WHERE tag = $tag;
      `;

      const preparedQuery = await session.prepareQuery(query);
      const result = await session.executeQuery(preparedQuery, {
        $tag: TypedValues.utf8(tag),
      });

      const rows = result.resultSets[0]?.rows || [];

      for (const rowData of rows) {
        const row = rowData as unknown as { cache_key: string };
        await this.delete(this.stripCacheKeyPrefix(row.cache_key));
      }
    });
  }

  async close(): Promise<void> {
    if (this.ydbDriver) {
      await this.ydbDriver.destroy();
      this.ydbDriver = null;
    }
  }

  private async initYDB(): Promise<void> {
    if (this.ydbDriver) {
      return;
    }

    let authService: IamAuthService | StaticCredentialsAuthService | MetadataAuthService;

    if (this.ydbCredentials?.type === 'service-account' && this.ydbCredentials.json) {
      authService = new IamAuthService(getSACredentialsFromJson(this.ydbCredentials.json));
    } else if (
      this.ydbCredentials?.type === 'access-key' &&
      this.ydbCredentials.accessKeyId &&
      this.ydbCredentials.secretAccessKey
    ) {
      authService = new StaticCredentialsAuthService(
        this.ydbCredentials.accessKeyId,
        this.ydbCredentials.secretAccessKey,
        'iam.api.cloud.yandex.net:443',
      );
    } else {
      authService = new MetadataAuthService();
    }

    this.ydbDriver = new Driver({
      endpoint: this.ydbEndpoint,
      database: this.ydbDatabase,
      authService,
    });

    const timeout = 10000;
    if (!(await this.ydbDriver.ready(timeout))) {
      throw new Error(`YDB driver failed to become ready in ${timeout}ms`);
    }

    await this.createTablesIfNeeded();
  }

  private async createTablesIfNeeded(): Promise<void> {
    if (!this.ydbDriver) {
      throw new Error('YDB driver not initialized');
    }

    await this.ydbDriver.tableClient.withSession(async (session: Session) => {
      const entriesTable = `${this.tablesPrefix}_entries`;
      try {
        await session.createTable(
          entriesTable,
          new TableDescription()
            .withColumns(
              new Column('cache_key', Types.UTF8),
              new Column('value', Types.JSON),
              new Column('ttl', Types.UINT64),
            )
            .withPrimaryKeys('cache_key'),
        );
      } catch (err) {
        this.ignoreAlreadyExists(err);
      }

      const tagsTable = `${this.tablesPrefix}_tags`;
      try {
        await session.createTable(
          tagsTable,
          new TableDescription()
            .withColumns(
              new Column('tag', Types.UTF8),
              new Column('cache_key', Types.UTF8),
              new Column('ttl', Types.UINT64),
            )
            .withPrimaryKeys('tag', 'cache_key'),
        );
      } catch (err) {
        this.ignoreAlreadyExists(err);
      }

      const locksTable = `${this.tablesPrefix}_locks`;
      try {
        await session.createTable(
          locksTable,
          new TableDescription()
            .withColumns(
              new Column('cache_key', Types.UTF8),
              new Column('locked', Types.BOOL),
              new Column('locked_at', Types.UINT64),
              new Column('ttl', Types.UINT64),
            )
            .withPrimaryKeys('cache_key'),
        );
      } catch (err) {
        this.ignoreAlreadyExists(err);
      }
    });
  }

  private async getMetadataFromYDB(key: string): Promise<any | null> {
    if (!this.ydbDriver) {
      throw new Error('YDB driver not initialized');
    }

    return this.ydbDriver.tableClient.withSession(async (session: Session) => {
      const query = `
        DECLARE $cache_key AS Utf8;

        SELECT value
        FROM \`${this.tablesPrefix}_entries\`
        WHERE cache_key = $cache_key;
      `;

      const preparedQuery = await session.prepareQuery(query);
      const result = await session.executeQuery(preparedQuery, {
        $cache_key: TypedValues.utf8(this.getCacheKey(key)),
      });

      const resultSet = result.resultSets[0];
      if (resultSet && resultSet.rows && resultSet.rows.length > 0) {
        const row = resultSet.rows[0] as any;
        return JSON.parse(row.value);
      }

      return null;
    });
  }

  private async setMetadataInYDB(key: string, metadata: any, ttlSeconds: number): Promise<void> {
    if (!this.ydbDriver) {
      throw new Error('YDB driver not initialized');
    }

    const ttl = Math.floor(Date.now() / 1000) + ttlSeconds;

    await this.ydbDriver.tableClient.withSession(async (session: Session) => {
      const query = `
        DECLARE $cache_key AS Utf8;
        DECLARE $value AS Json;
        DECLARE $ttl AS Uint64;

        UPSERT INTO \`${this.tablesPrefix}_entries\`
        (cache_key, value, ttl)
        VALUES ($cache_key, $value, $ttl);
      `;

      const preparedQuery = await session.prepareQuery(query);
      await session.executeQuery(preparedQuery, {
        $cache_key: TypedValues.utf8(this.getCacheKey(key)),
        $value: TypedValues.json(JSON.stringify(metadata)),
        $ttl: TypedValues.uint64(ttl),
      });
    });
  }

  private async setTagsInYDB(key: string, tags: string[], ttlSeconds: number): Promise<void> {
    if (!this.ydbDriver) {
      throw new Error('YDB driver not initialized');
    }

    const ttl = Math.floor(Date.now() / 1000) + ttlSeconds;

    await this.ydbDriver.tableClient.withSession(async (session: Session) => {
      for (const tag of tags) {
        const query = `
          DECLARE $tag AS Utf8;
          DECLARE $cache_key AS Utf8;
          DECLARE $ttl AS Uint64;

          UPSERT INTO \`${this.tablesPrefix}_tags\`
          (tag, cache_key, ttl)
          VALUES ($tag, $cache_key, $ttl);
        `;

        const preparedQuery = await session.prepareQuery(query);
        await session.executeQuery(preparedQuery, {
          $tag: TypedValues.utf8(tag),
          $cache_key: TypedValues.utf8(this.getCacheKey(key)),
          $ttl: TypedValues.uint64(ttl),
        });
      }
    });
  }

  private async deleteFromYDB(key: string): Promise<void> {
    if (!this.ydbDriver) {
      throw new Error('YDB driver not initialized');
    }

    await this.ydbDriver.tableClient.withSession(async (session: Session) => {
      const deleteEntryQuery = `
        DECLARE $cache_key AS Utf8;

        DELETE FROM \`${this.tablesPrefix}_entries\`
        WHERE cache_key = $cache_key;
      `;

      const preparedEntryQuery = await session.prepareQuery(deleteEntryQuery);
      await session.executeQuery(preparedEntryQuery, {
        $cache_key: TypedValues.utf8(this.getCacheKey(key)),
      });

      const deleteTagsQuery = `
        DECLARE $cache_key AS Utf8;

        DELETE FROM \`${this.tablesPrefix}_tags\`
        WHERE cache_key = $cache_key;
      `;

      const preparedTagsQuery = await session.prepareQuery(deleteTagsQuery);
      await session.executeQuery(preparedTagsQuery, {
        $cache_key: TypedValues.utf8(this.getCacheKey(key)),
      });
    });
  }

  private getCacheKey(key: string): string {
    return `${this.buildId}:${key}`;
  }

  private stripCacheKeyPrefix(cacheKey: string): string {
    const prefix = `${this.buildId}:`;
    return cacheKey.startsWith(prefix) ? cacheKey.substring(prefix.length) : cacheKey;
  }

  private getS3Key(key: string): string {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return `${this.tablesPrefix}/${this.buildId}/${hash.substring(0, 2)}/${hash}`;
  }

  private ignoreAlreadyExists(err: unknown): void {
    const msg = (err as { message?: string } | undefined)?.message || '';
    if (!msg.includes('already exists')) {
      throw err;
    }
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
