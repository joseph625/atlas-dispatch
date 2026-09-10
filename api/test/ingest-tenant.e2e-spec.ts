import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { computeSignature } from '../src/webhooks/hmac';

/**
 * The three API tests required by the brief, end-to-end against a running
 * Postgres (DATABASE_URL): bad signature, duplicate event (= one work item),
 * and cross-tenant denial (user A denied workspace B). Creates isolated `e2e-*`
 * fixtures and tears them down; never touches seed data.
 */
describe('Ingest + auth + tenancy (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const SECRET = 'e2e_secret_value';
  const KEY_ID = 'e2e_stripe_key';
  const PASSWORD = 'e2e_password';

  let acmeId: string;
  let adminToken: string; // ops-admin, member of e2e-acme
  let viewerToken: string; // ops-viewer, member of e2e-north

  async function cleanup(p: PrismaService) {
    await p.workspace.deleteMany({ where: { slug: { in: ['e2e-acme', 'e2e-north'] } } });
    await p.user.deleteMany({ where: { email: { in: ['e2e-admin@test', 'e2e-viewer@test'] } } });
  }

  async function ensureRole(name: string, perms: string[]) {
    const role = await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
    for (const pname of perms) {
      const perm = await prisma.permission.upsert({
        where: { name: pname },
        update: {},
        create: { name: pname },
      });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
    return role.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(
      json({
        limit: 65536, // mirror main.ts so the oversized-body path is exercised for real
        type: () => true,
        verify: (req: any, _res, buf) => {
          req.rawBody = Buffer.from(buf);
        },
      }),
    );
    app.use(cookieParser());
    await app.init();

    prisma = app.get(PrismaService);
    await cleanup(prisma);

    const adminRoleId = await ensureRole('ops-admin', ['workitem:read', 'workitem:retry']);
    const viewerRoleId = await ensureRole('ops-viewer', ['workitem:read']);

    const acme = await prisma.workspace.create({ data: { slug: 'e2e-acme', name: 'E2E Acme' } });
    const north = await prisma.workspace.create({ data: { slug: 'e2e-north', name: 'E2E North' } });
    acmeId = acme.id;

    const hash = await bcrypt.hash(PASSWORD, 10);
    const admin = await prisma.user.create({
      data: { email: 'e2e-admin@test', name: 'Admin', password: hash },
    });
    const viewer = await prisma.user.create({
      data: { email: 'e2e-viewer@test', name: 'Viewer', password: hash },
    });

    await prisma.membership.create({ data: { userId: admin.id, workspaceId: acme.id } });
    await prisma.membership.create({ data: { userId: viewer.id, workspaceId: north.id } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRoleId } });
    await prisma.userRole.create({ data: { userId: viewer.id, roleId: viewerRoleId } });

    await prisma.vendorCredential.create({
      data: { keyId: KEY_ID, vendor: 'stripe', secret: SECRET, workspaceId: acme.id },
    });

    adminToken = await loginToken('e2e-admin@test');
    viewerToken = await loginToken('e2e-viewer@test');
  });

  afterAll(async () => {
    await cleanup(prisma);
    await app.close();
  });

  async function loginToken(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken;
  }

  function signed(body: object) {
    const raw = JSON.stringify(body);
    const t = Math.floor(Date.now() / 1000);
    const v1 = computeSignature(SECRET, t, Buffer.from(raw));
    return { raw, header: `t=${t},v1=${v1}` };
  }

  function sendWebhook(body: object, sigHeader?: string) {
    const { raw, header } = signed(body);
    return request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('x-webhook-key', KEY_ID)
      .set('x-signature', sigHeader ?? header)
      .send(raw);
  }

  it('rejects a bad signature with 401', async () => {
    await sendWebhook({ id: 'e2e_badsig' }, 't=9999999999,v1=deadbeef').expect(401);
  });

  it('is idempotent: a duplicate vendor event id yields exactly one work item', async () => {
    const body = { id: 'e2e_dup_1', type: 'charge.succeeded', simulate: 'ok' };
    const r1 = await sendWebhook(body).expect(200);
    expect(r1.body.data.outcome).toBe('accepted');
    const r2 = await sendWebhook(body).expect(200);
    expect(r2.body.data.outcome).toBe('duplicate');
    expect(r2.body.data.workItemId).toBe(r1.body.data.workItemId);

    const events = await prisma.event.findMany({
      where: { workspaceId: acmeId, vendor: 'stripe', vendorEventId: 'e2e_dup_1' },
    });
    expect(events).toHaveLength(1);
    expect(await prisma.workItem.count({ where: { eventId: events[0].id } })).toBe(1);
  });

  it('denies a non-member with 404 (no tenant leak) and allows the member', async () => {
    await sendWebhook({ id: 'e2e_leak_1', simulate: 'ok' }).expect(200);

    await request(app.getHttpServer())
      .get('/workspaces/e2e-acme/work-items')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    // viewer is a member of e2e-north only -> e2e-acme is 404, same as unknown slug
    await request(app.getHttpServer())
      .get('/workspaces/e2e-acme/work-items')
      .set('authorization', `Bearer ${viewerToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .get('/workspaces/does-not-exist/work-items')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
