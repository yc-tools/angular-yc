import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import chalk from 'chalk';
import ora from 'ora';

export interface UploadOptions {
  buildDir: string;
  assetsBucket: string;
  region?: string;
  endpoint?: string;
  verbose?: boolean;
  dryRun?: boolean;
}

export class Uploader {
  private s3Client!: S3Client;

  async upload(options: UploadOptions): Promise<void> {
    const spinner = ora();
    const {
      buildDir,
      assetsBucket,
      region = 'ru-central1',
      endpoint = 'https://storage.yandexcloud.net',
      verbose,
      dryRun,
    } = options;

    this.s3Client = new S3Client({
      region,
      endpoint,
    });

    try {
      if (!(await fs.pathExists(buildDir))) {
        throw new Error(`Build directory not found: ${buildDir}`);
      }

      spinner.start('Uploading static assets...');
      const assetsDir = path.join(buildDir, 'artifacts', 'assets');
      if (await fs.pathExists(assetsDir)) {
        const uploaded = await this.uploadDirectory(assetsDir, assetsBucket, '', dryRun, verbose);
        spinner.succeed(`Uploaded ${uploaded.length} asset files`);
      } else {
        spinner.warn('No static assets found');
      }

      const functionZips = [
        { file: 'server.zip', key: 'functions/server.zip' },
        { file: 'image.zip', key: 'functions/image.zip' },
      ];

      for (const { file, key } of functionZips) {
        const zipPath = path.join(buildDir, 'artifacts', file);
        if (await fs.pathExists(zipPath)) {
          spinner.start(`Uploading ${file}...`);
          if (!dryRun) {
            await this.uploadFile(zipPath, assetsBucket, key);
          }
          spinner.succeed(`Uploaded ${file}`);
          if (verbose) {
            console.log(chalk.gray(`  -> s3://${assetsBucket}/${key}`));
          }
        }
      }

      const manifestPath = path.join(buildDir, 'deploy.manifest.json');
      if (await fs.pathExists(manifestPath)) {
        spinner.start('Uploading deployment manifest...');
        if (!dryRun) {
          await this.uploadFile(manifestPath, assetsBucket, 'manifest.json');
        }
        spinner.succeed('Uploaded deployment manifest');
      }

      if (dryRun) {
        console.log(chalk.yellow('\nDry run mode enabled. No files were uploaded.'));
      } else {
        console.log(chalk.cyan('\nUpload summary:'));
        console.log(chalk.gray(`  Assets bucket: ${assetsBucket}`));
      }
    } catch (error) {
      spinner.fail('Upload failed');
      throw error;
    }
  }

  private async uploadDirectory(
    localDir: string,
    bucket: string,
    s3Prefix: string,
    dryRun?: boolean,
    verbose?: boolean,
  ): Promise<string[]> {
    const files = await glob('**/*', {
      cwd: localDir,
      nodir: true,
    });

    const uploaded: string[] = [];

    for (const file of files) {
      const localPath = path.join(localDir, file);
      const s3Key = s3Prefix ? `${s3Prefix}/${file}` : file;

      if (!dryRun) {
        await this.uploadFile(localPath, bucket, s3Key);
      }

      uploaded.push(s3Key);
      if (verbose) {
        console.log(chalk.gray(`  Uploaded: ${file}`));
      }
    }

    return uploaded;
  }

  private async uploadFile(localPath: string, bucket: string, key: string): Promise<void> {
    const fileStream = fs.createReadStream(localPath);

    const ext = path.extname(localPath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.txt': 'text/plain',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';

    let cacheControl = 'public, max-age=3600';

    if (this.isImmutableAsset(key)) {
      cacheControl = 'public, max-age=31536000, immutable';
    } else if (ext === '.html') {
      cacheControl = 'public, max-age=0, must-revalidate';
    } else if (key.includes('/prerender/')) {
      cacheControl = 'public, max-age=60, stale-while-revalidate=30';
    }

    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: fileStream,
        ContentType: contentType,
        CacheControl: cacheControl,
        Metadata: {
          'upload-timestamp': new Date().toISOString(),
        },
      },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
    });

    upload.on('httpUploadProgress', () => {
      // No-op: optionally exposed for future progress reporting.
    });

    await upload.done();
  }

  async listObjects(bucket: string, prefix: string): Promise<string[]> {
    const response = await this.s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
      }),
    );

    return (response.Contents || []).map((obj) => obj.Key || '').filter(Boolean);
  }

  private isImmutableAsset(key: string): boolean {
    if (key.includes('/browser/')) {
      const filename = path.basename(key);
      if (/\.[a-f0-9]{8,}\./i.test(filename)) {
        return true;
      }
      if (filename.includes('chunk') || filename.includes('bundle')) {
        return true;
      }
    }

    return key.includes('/assets/') && !key.endsWith('.html');
  }
}
