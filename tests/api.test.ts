import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createApp, type ApiDeps } from '../src/api';
import type { MappingEntry } from '../src/types';

function createMockDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    getMapping: mock(() => []),
    setMapping: mock(() => {}),
    handleGsiPayload: mock(() => {}),
    ...overrides,
  };
}

describe('POST /', () => {
  it('passes parsed JSON body to handleGsiPayload and returns 200', async () => {
    const handleGsiPayload = mock(() => {});
    const deps = createMockDeps({ handleGsiPayload });
    const app = createApp(deps);

    const payload = { player: { kills: 5 }, map: { matchid: 123 } };
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
    expect(handleGsiPayload).toHaveBeenCalledTimes(1);
    expect(handleGsiPayload).toHaveBeenCalledWith(payload);
  });

  it('handles empty object payload', async () => {
    const handleGsiPayload = mock(() => {});
    const deps = createMockDeps({ handleGsiPayload });
    const app = createApp(deps);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(handleGsiPayload).toHaveBeenCalledTimes(1);
    expect(handleGsiPayload).toHaveBeenCalledWith({});
  });
});

// ─── /api/mappings ──────────────────────────────────────────────

describe('GET /api/mappings', () => {
  let originalBunFile: typeof Bun.file;

  beforeEach(() => {
    originalBunFile = Bun.file.bind(Bun);
  });

  afterEach(() => {
    (Bun as any).file = originalBunFile;
  });

  it('returns mapping data from disk as JSON', async () => {
    const mappings: MappingEntry[] = [
      { event: 'player.kills', sound: 'kill.mp3', condition: '>', value: 0 },
      { event: 'player.deaths', sound: 'death.mp3', condition: '*', value: 0 },
    ];

    (Bun as any).file = mock(() => ({
      json: async () => mappings,
    }));

    const deps = createMockDeps();
    const app = createApp(deps);

    const res = await app.request('/api/mappings');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(mappings);
  });

  it('returns empty array when mapping file is empty', async () => {
    (Bun as any).file = mock(() => ({
      json: async () => [],
    }));

    const deps = createMockDeps();
    const app = createApp(deps);

    const res = await app.request('/api/mappings');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('PUT /api/mappings', () => {
  let originalBunFile: typeof Bun.file;
  let originalBunWrite: typeof Bun.write;

  beforeEach(() => {
    originalBunFile = Bun.file.bind(Bun);
    originalBunWrite = Bun.write.bind(Bun);
  });

  afterEach(() => {
    (Bun as any).file = originalBunFile;
    (Bun as any).write = originalBunWrite;
  });

  it('writes mappings to disk and calls setMapping', async () => {
    const mockWrite = mock(async () => 0);
    (Bun as any).write = mockWrite;

    const setMapping = mock(() => {});
    const deps = createMockDeps({ setMapping });
    const app = createApp(deps);

    const mappings: MappingEntry[] = [
      { event: 'player.kills', sound: 'kill.mp3', condition: '>', value: 3 },
    ];

    const res = await app.request('/api/mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mappings),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // verify it wrote the correct file with pretty-printed JSON
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledWith('mapping.json', JSON.stringify(mappings, null, 2));

    // verify it updated the in-memory mapping
    expect(setMapping).toHaveBeenCalledTimes(1);
    expect(setMapping).toHaveBeenCalledWith(mappings);
  });

  it('handles empty array of mappings', async () => {
    const mockWrite = mock(async () => 0);
    (Bun as any).write = mockWrite;

    const setMapping = mock(() => {});
    const deps = createMockDeps({ setMapping });
    const app = createApp(deps);

    const res = await app.request('/api/mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockWrite).toHaveBeenCalledWith('mapping.json', '[]');
    expect(setMapping).toHaveBeenCalledWith([]);
  });
});
