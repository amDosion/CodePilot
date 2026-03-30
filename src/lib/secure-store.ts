import fs from 'node:fs/promises';
import path from 'node:path';

export interface SecureStoreCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

type SecureStoreMap = Record<string, string>;

export class FileSecureStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: SecureStoreCipher,
  ) {}

  private async readStore(): Promise<SecureStoreMap> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const store: SecureStoreMap = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          store[key] = value;
        }
      }
      return store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  private async writeStore(store: SecureStoreMap): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(store, null, 2), 'utf8');
  }

  private ensureCipher(): void {
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available in this runtime');
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.ensureCipher();
    const store = await this.readStore();
    store[key] = this.cipher.encryptString(value).toString('base64');
    await this.writeStore(store);
  }

  async get(key: string): Promise<string | null> {
    this.ensureCipher();
    const store = await this.readStore();
    const encrypted = store[key];
    if (!encrypted) {
      return null;
    }
    return this.cipher.decryptString(Buffer.from(encrypted, 'base64'));
  }

  async delete(key: string): Promise<void> {
    const store = await this.readStore();
    if (!(key in store)) {
      return;
    }
    delete store[key];
    await this.writeStore(store);
  }

  async setJson<T>(key: string, value: T): Promise<void> {
    await this.set(key, JSON.stringify(value));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as T;
  }
}
