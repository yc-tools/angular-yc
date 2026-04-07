import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs-extra';
import { glob } from 'glob';
import { Uploader } from './index.js';

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(),
  ListObjectsV2Command: vi.fn(),
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn(),
}));

vi.mock('fs-extra');
vi.mock('glob');
vi.mock('chalk', () => ({
  default: {
    gray: (s: string) => s,
    cyan: (s: string) => s,
    yellow: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
  },
}));
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  })),
}));

describe('Uploader', () => {
  let uploader: Uploader;
  let mockS3Send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    uploader = new Uploader();
    vi.clearAllMocks();

    mockS3Send = vi.fn().mockResolvedValue({});
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockS3Send }) as any);

    vi.mocked(Upload).mockImplementation(
      () =>
        ({
          on: vi.fn().mockReturnThis(),
          done: vi.fn().mockResolvedValue({}),
        }) as any,
    );

    vi.mocked(fs.pathExists).mockResolvedValue(true);
    vi.mocked(fs.createReadStream).mockReturnValue({} as any);
    vi.mocked(glob).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads static assets to object storage', async () => {
    vi.mocked(glob).mockResolvedValue(['browser/main.js', 'browser/styles.css']);

    await uploader.upload({
      buildDir: '/test/build',
      assetsBucket: 'assets-bucket',
    });

    expect(Upload).toHaveBeenCalled();
  });

  it('supports dry run without actual upload calls', async () => {
    vi.mocked(glob).mockResolvedValue(['browser/main.js']);

    await uploader.upload({
      buildDir: '/test/build',
      assetsBucket: 'assets-bucket',
      dryRun: true,
    });

    expect(Upload).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('handles upload errors', async () => {
    vi.mocked(glob).mockResolvedValue(['browser/main.js']);
    vi.mocked(Upload).mockImplementation(
      () =>
        ({
          on: vi.fn().mockReturnThis(),
          done: vi.fn().mockRejectedValue(new Error('S3 upload error')),
        }) as any,
    );

    await expect(
      uploader.upload({
        buildDir: '/test/build',
        assetsBucket: 'assets-bucket',
      }),
    ).rejects.toThrow('S3 upload error');
  });

  it('throws when build directory does not exist', async () => {
    vi.mocked(fs.pathExists).mockResolvedValue(false);

    await expect(
      uploader.upload({
        buildDir: '/test/build',
        assetsBucket: 'assets-bucket',
      }),
    ).rejects.toThrow('Build directory not found');
  });

  it('uploads server and image zips when present', async () => {
    vi.mocked(fs.pathExists).mockImplementation(async (target) => {
      const p = target.toString();
      if (p.endsWith('server.zip') || p.endsWith('image.zip')) {
        return true;
      }
      return true;
    });

    await uploader.upload({
      buildDir: '/test/build',
      assetsBucket: 'assets-bucket',
    });

    const zipUploads = vi
      .mocked(Upload)
      .mock.calls.filter((call: any[]) => String(call[0]?.params?.Key || '').includes('.zip'));

    expect(zipUploads.length).toBeGreaterThanOrEqual(2);
  });

  it('uses custom endpoint when provided', async () => {
    await uploader.upload({
      buildDir: '/test/build',
      assetsBucket: 'assets-bucket',
      endpoint: 'https://custom-storage.yandexcloud.net',
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://custom-storage.yandexcloud.net' }),
    );
  });

  it('uploads manifest file when present', async () => {
    vi.mocked(fs.pathExists).mockResolvedValue(true);

    await uploader.upload({
      buildDir: '/test/build',
      assetsBucket: 'assets-bucket',
    });

    const manifestUpload = vi
      .mocked(Upload)
      .mock.calls.find((call: any[]) =>
        String(call[0]?.params?.Key || '').includes('manifest.json'),
      );

    expect(manifestUpload).toBeDefined();
  });

  it('lists objects by prefix', async () => {
    mockS3Send.mockResolvedValue({
      Contents: [{ Key: 'prefix/a.txt' }, { Key: 'prefix/b.txt' }],
    });

    await uploader.upload({
      buildDir: '/test/build',
      assetsBucket: 'assets-bucket',
    });

    const keys = await uploader.listObjects('assets-bucket', 'prefix/');
    expect(keys).toEqual(['prefix/a.txt', 'prefix/b.txt']);
  });
});
