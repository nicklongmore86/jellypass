import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GrantRecord, GrantState } from './types.js';

const EMPTY_STATE: GrantState = { version: 1, grants: {} };

export class GrantStore {
  readonly #file: string;
  #state: GrantState = structuredClone(EMPTY_STATE);

  public constructor(file: string) {
    this.#file = file;
  }

  public async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as unknown;
      if (!isGrantState(parsed)) {
        throw new Error('state file does not match schema version 1');
      }
      this.#state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      await this.#save();
    }
  }

  public list(): GrantRecord[] {
    return Object.values(this.#state.grants).map((grant) => structuredClone(grant));
  }

  public get(itemId: string): GrantRecord | undefined {
    const grant = this.#state.grants[normalizeId(itemId)];
    return grant ? structuredClone(grant) : undefined;
  }

  public async grant(input: {
    itemId: string;
    mediaType?: string;
    requestId: string;
    userId: string;
  }): Promise<GrantRecord> {
    const itemId = normalizeId(input.itemId);
    const userId = normalizeId(input.userId);
    const previous = this.#state.grants[itemId];
    const requests = { ...(previous?.requests ?? {}), [input.requestId]: userId };
    const owners = [...new Set(Object.values(requests))].sort();
    const next: GrantRecord = {
      itemId,
      owners,
      requests,
      updatedAt: new Date().toISOString(),
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    };
    this.#state.grants[itemId] = next;
    await this.#save();
    return structuredClone(next);
  }

  async #save(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
  }
}

export function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function isGrantState(value: unknown): value is GrantState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GrantState>;
  return candidate.version === 1 && !!candidate.grants && typeof candidate.grants === 'object';
}
