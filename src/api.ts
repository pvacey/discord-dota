import { Hono } from 'hono';
import type { MappingEntry } from './types';

export interface ApiDeps {
  getMapping(): MappingEntry[];
  setMapping(data: MappingEntry[]): void;
  handleGsiPayload(payload: Record<string, unknown>): void;
}

export function createApp(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/api/mappings', async (c) => {
    const f = Bun.file('mapping.json');
    const data = await f.json();
    return c.json(data);
  });

  app.put('/api/mappings', async (c) => {
    const data = (await c.req.json()) as MappingEntry[];
    await Bun.write('mapping.json', JSON.stringify(data, null, 2));
    deps.setMapping(data);
    return c.json({ success: true });
  });

  app.get('/', async (c) => {
    const file = Bun.file('./public/index.html');
    return c.html(await file.text());
  });

  app.post('/', async (c) => {
    const payload = await c.req.json();
    deps.handleGsiPayload(payload);
    return c.text('OK', 200);
  });

  return app;
}
