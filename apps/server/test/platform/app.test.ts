import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/platform/errors.ts';
import { Readiness } from '../../src/platform/readiness.ts';
import { parseInput } from '../../src/platform/validation.ts';
import { platformFixture, readyApps, type PlatformFixture } from '../support/platform.ts';

let fx: PlatformFixture;
beforeAll(async () => {
  fx = await platformFixture();
});
afterAll(async () => {
  await fx.close();
});

const staffRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ping', async () => ({ listener: 'staff' }));
  app.get('/stock', async () => {
    throw new AppError('INSUFFICIENT_STOCK', 'Oat milk: need 300 ml, available 120 ml', {
      shortages: [{ itemName: 'Oat milk', required: '300.0000', available: '120.0000' }],
    });
  });
  app.get('/boom', async () => {
    throw new Error('secret connection string postgres://user:pw@host');
  });
  app.post('/validate', async (request) => {
    const body = parseInput(z.object({ qty: z.number().int().positive() }).strict(), request.body);
    return { qty: body.qty };
  });
};
const customerRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ping', async () => ({ listener: 'customer' }));
};

describe('error responses (API.md §6)', () => {
  it('sends business errors as problem+json with code, extra fields and correlation id', async () => {
    const { staff } = readyApps(fx.pool, { staff: staffRoutes });
    const res = await staff.inject({ method: 'GET', url: '/api/staff/v1/stock' });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      status: 422,
      detail: 'Oat milk: need 300 ml, available 120 ml',
      shortages: [{ itemName: 'Oat milk' }],
    });
    expect(body['correlationId']).toBe(res.headers['x-correlation-id']);
  });

  it('hides internal error details from the client', async () => {
    const { staff } = readyApps(fx.pool, { staff: staffRoutes });
    const res = await staff.inject({ method: 'GET', url: '/api/staff/v1/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body).not.toMatch(/secret|postgres/);
  });

  it('reports invalid input field by field', async () => {
    const { staff } = readyApps(fx.pool, { staff: staffRoutes });
    const res = await staff.inject({
      method: 'POST',
      url: '/api/staff/v1/validate',
      payload: { qty: -1, extra: true },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string; fields: { path: string }[] }>();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields.map((f) => f.path).sort()).toEqual(['', 'qty']);
  });

  it('treats malformed JSON as invalid input, and unknown routes as NOT_FOUND', async () => {
    const { staff } = readyApps(fx.pool, { staff: staffRoutes });
    const bad = await staff.inject({
      method: 'POST',
      url: '/api/staff/v1/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{"qty": ',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const missing = await staff.inject({ method: 'GET', url: '/api/staff/v1/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('correlation ids', () => {
  it('echoes a valid client id and replaces an invalid one', async () => {
    const { staff } = readyApps(fx.pool, { staff: staffRoutes });
    const id = randomUUID();
    const ok = await staff.inject({
      method: 'GET',
      url: '/api/staff/v1/ping',
      headers: { 'x-correlation-id': id.toUpperCase() },
    });
    expect(ok.headers['x-correlation-id']).toBe(id);
    const bad = await staff.inject({
      method: 'GET',
      url: '/api/staff/v1/ping',
      headers: { 'x-correlation-id': 'not-a-uuid' },
    });
    expect(bad.headers['x-correlation-id']).not.toBe('not-a-uuid');
    expect(bad.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets no-store and nosniff headers on API responses', async () => {
    const { staff } = readyApps(fx.pool, { staff: staffRoutes });
    const res = await staff.inject({ method: 'GET', url: '/api/staff/v1/ping' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('readiness gate (503 SERVER_STARTING until startup checks pass)', () => {
  it('blocks business routes but answers health checks', async () => {
    const readiness = new Readiness();
    const { staff } = readyApps(fx.pool, { staff: staffRoutes }, readiness);

    const blocked = await staff.inject({ method: 'GET', url: '/api/staff/v1/ping' });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({ code: 'SERVER_STARTING' });
    expect((await staff.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await staff.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);

    readiness.clear('startup_pending');
    expect((await staff.inject({ method: 'GET', url: '/api/staff/v1/ping' })).statusCode).toBe(200);
    const ready = await staff.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.json()).toMatchObject({ status: 'ready' });
  });
});

describe('two listeners (API.md §1)', () => {
  it('serves customer and staff routes on separate ports, never crossing over', async () => {
    const { customer, staff } = readyApps(fx.pool, {
      customer: customerRoutes,
      staff: staffRoutes,
    });
    await customer.listen({ host: '127.0.0.1', port: 0 });
    await staff.listen({ host: '127.0.0.1', port: 0 });
    try {
      const customerUrl = `http://127.0.0.1:${String(customer.addresses()[0]?.port)}`;
      const staffUrl = `http://127.0.0.1:${String(staff.addresses()[0]?.port)}`;
      expect(customerUrl).not.toBe(staffUrl);

      const c = await fetch(`${customerUrl}/api/customer/v1/ping`);
      expect(await c.json()).toEqual({ listener: 'customer' });
      const s = await fetch(`${staffUrl}/api/staff/v1/ping`);
      expect(await s.json()).toEqual({ listener: 'staff' });

      // Staff routes do not exist on the customer port, and vice versa.
      expect((await fetch(`${customerUrl}/api/staff/v1/ping`)).status).toBe(404);
      expect((await fetch(`${staffUrl}/api/customer/v1/ping`)).status).toBe(404);
    } finally {
      await Promise.all([customer.close(), staff.close()]);
    }
  });
});
