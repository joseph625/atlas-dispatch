import * as dotenv from 'dotenv';
import { Prisma, PrismaClient, WorkItemStatus } from './generated/client';

dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` });

import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';

// Prisma 7: connect through the pg driver adapter.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const SEED_PASSWORD = process.env.SEED_PASSWORD || 'password';

// RBAC: permissions are action-capabilities; roles bundle them.
const PERMISSIONS = [
  { name: 'workitem:read', description: 'View events / work items' },
  { name: 'workitem:retry', description: 'Retry dead/failed work items' },
];
const ROLES = [
  { name: 'ops-admin', description: 'Full ops: read + retry', permissions: ['workitem:read', 'workitem:retry'] },
  { name: 'ops-viewer', description: 'Read-only ops', permissions: ['workitem:read'] },
];

// Seed credentials are ALSO used by scripts/webhook.sh — keep them in sync.
const CREDENTIALS = [
  {
    keyId: 'acme_stripe_key',
    vendor: 'stripe',
    workspaceSlug: 'acme',
    secret: 'whsec_acme_stripe_dev',
  },
  {
    keyId: 'acme_shipping_key',
    vendor: 'shipping',
    workspaceSlug: 'acme',
    secret: 'whsec_acme_shipping_dev',
  },
  {
    keyId: 'northline_stripe_key',
    vendor: 'stripe',
    workspaceSlug: 'northline-shop',
    secret: 'whsec_northline_stripe_dev',
  },
];

interface SeedItem {
  vendor: string;
  vendorEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: WorkItemStatus;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
}

// A spread across every status, per workspace, so filters + detail have data.
const acmeItems: SeedItem[] = [
  {
    vendor: 'stripe',
    vendorEventId: 'evt_acme_1001',
    eventType: 'charge.succeeded',
    payload: { id: 'evt_acme_1001', type: 'charge.succeeded', amount: 4200, currency: 'usd', simulate: 'ok' },
    status: 'done',
    attempts: 1,
    maxAttempts: 3,
  },
  {
    vendor: 'stripe',
    vendorEventId: 'evt_acme_1002',
    eventType: 'charge.refunded',
    payload: { id: 'evt_acme_1002', type: 'charge.refunded', amount: 999, simulate: 'fail-until:2' },
    status: 'done',
    attempts: 2,
    maxAttempts: 3,
  },
  {
    vendor: 'shipping',
    vendorEventId: 'evt_acme_2001',
    eventType: 'shipment.delivered',
    payload: { id: 'evt_acme_2001', type: 'shipment.delivered', tracking: '1Z-ACME-9', simulate: 'ok' },
    status: 'done',
    attempts: 1,
    maxAttempts: 3,
  },
  {
    vendor: 'shipping',
    vendorEventId: 'evt_acme_2002',
    eventType: 'shipment.lost',
    // fail-until:5 -> dead at 3 attempts, recoverable via operator retry (which extends budget)
    payload: { id: 'evt_acme_2002', type: 'shipment.lost', tracking: '1Z-ACME-DEAD', simulate: 'fail-until:5' },
    status: 'dead',
    attempts: 3,
    maxAttempts: 3,
    lastError: 'simulated transient failure (attempt 3 < 5)',
  },
  {
    vendor: 'stripe',
    vendorEventId: 'evt_acme_1003',
    eventType: 'charge.disputed',
    payload: { id: 'evt_acme_1003', type: 'charge.disputed', amount: 15000, simulate: 'fail' },
    status: 'failed',
    attempts: 1,
    maxAttempts: 3,
    lastError: 'simulated permanent failure',
  },
  {
    vendor: 'stripe',
    vendorEventId: 'evt_acme_1004',
    eventType: 'invoice.created',
    payload: { id: 'evt_acme_1004', type: 'invoice.created', amount: 3300, simulate: 'ok' },
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
  },
];

const northlineItems: SeedItem[] = [
  {
    vendor: 'stripe',
    vendorEventId: 'evt_north_5001',
    eventType: 'checkout.completed',
    payload: { id: 'evt_north_5001', type: 'checkout.completed', amount: 8800, simulate: 'ok' },
    status: 'done',
    attempts: 1,
    maxAttempts: 3,
  },
  {
    vendor: 'stripe',
    vendorEventId: 'evt_north_5002',
    eventType: 'checkout.failed',
    payload: { id: 'evt_north_5002', type: 'checkout.failed', amount: 1200, simulate: 'fail' },
    status: 'dead',
    attempts: 3,
    maxAttempts: 3,
    lastError: 'simulated permanent failure',
  },
];

async function seedWorkspaceItems(workspaceId: string, items: SeedItem[]) {
  for (const it of items) {
    const event = await prisma.event.upsert({
      where: {
        workspaceId_vendor_vendorEventId: {
          workspaceId,
          vendor: it.vendor,
          vendorEventId: it.vendorEventId,
        },
      },
      update: {},
      create: {
        workspaceId,
        vendor: it.vendor,
        vendorEventId: it.vendorEventId,
        eventType: it.eventType,
        payload: it.payload as Prisma.InputJsonValue,
        signature: 't=seed,v1=seed',
      },
    });

    const workItem = await prisma.workItem.upsert({
      where: { eventId: event.id },
      update: {
        status: it.status,
        attempts: it.attempts,
        maxAttempts: it.maxAttempts,
        lastError: it.lastError ?? null,
      },
      create: {
        workspaceId,
        eventId: event.id,
        vendor: it.vendor,
        status: it.status,
        attempts: it.attempts,
        maxAttempts: it.maxAttempts,
        lastError: it.lastError ?? null,
      },
    });

    // Rebuild a plausible transition history for the detail view.
    await prisma.statusTransition.deleteMany({ where: { workItemId: workItem.id } });
    const transitions: { from: WorkItemStatus | null; to: WorkItemStatus; attempt: number; note: string }[] = [
      { from: null, to: 'pending', attempt: 0, note: 'received' },
    ];
    for (let a = 1; a <= it.attempts; a++) {
      const isLast = a === it.attempts;
      let to: WorkItemStatus;
      if (it.status === 'done' && isLast) to = 'done';
      else if (it.status === 'dead' && isLast) to = 'dead';
      else to = 'failed';
      transitions.push({
        from: transitions[transitions.length - 1].to,
        to,
        attempt: a,
        note: to === 'done' ? 'handled' : (it.lastError ?? 'simulated failure'),
      });
    }
    for (const t of transitions) {
      await prisma.statusTransition.create({
        data: {
          workItemId: workItem.id,
          fromStatus: t.from,
          toStatus: t.to,
          attempt: t.attempt,
          note: t.note,
        },
      });
    }
  }
}

async function main() {
  // Workspaces
  const acme = await prisma.workspace.upsert({
    where: { slug: 'acme' },
    update: { name: 'Acme Freight' },
    create: { slug: 'acme', name: 'Acme Freight' },
  });
  const northline = await prisma.workspace.upsert({
    where: { slug: 'northline-shop' },
    update: { name: 'Northline Shop' },
    create: { slug: 'northline-shop', name: 'Northline Shop' },
  });

  // RBAC: permissions + roles + role→permission links
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: p.name },
      update: { description: p.description },
      create: p,
    });
  }
  const roleByName: Record<string, string> = {};
  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description },
      create: { name: r.name, description: r.description },
    });
    roleByName[r.name] = role.id;
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    for (const permName of r.permissions) {
      const perm = await prisma.permission.findUnique({ where: { name: permName } });
      if (perm) {
        await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      }
    }
  }

  // Users (bcrypt-hashed shared demo password)
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  const alice = await prisma.user.upsert({
    where: { email: 'alice@acme.test' },
    update: { name: 'Alice (Acme Ops)', password: passwordHash },
    create: { email: 'alice@acme.test', name: 'Alice (Acme Ops)', password: passwordHash },
  });
  const bob = await prisma.user.upsert({
    where: { email: 'bob@northline.test' },
    update: { name: 'Bob (Northline Ops)', password: passwordHash },
    create: { email: 'bob@northline.test', name: 'Bob (Northline Ops)', password: passwordHash },
  });

  // Role assignments: Alice is ops-admin (can retry), Bob is ops-viewer (read-only).
  const assignRole = async (userId: string, roleName: string) => {
    const roleId = roleByName[roleName];
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId } },
      update: {},
      create: { userId, roleId },
    });
  };
  await prisma.userRole.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
  await assignRole(alice.id, 'ops-admin');
  await assignRole(bob.id, 'ops-viewer');

  // Memberships (single-tenant each — this is what tenant isolation protects)
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: alice.id, workspaceId: acme.id } },
    update: {},
    create: { userId: alice.id, workspaceId: acme.id, role: 'admin' },
  });
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: bob.id, workspaceId: northline.id } },
    update: {},
    create: { userId: bob.id, workspaceId: northline.id, role: 'admin' },
  });

  // Vendor credentials
  const slugToId: Record<string, string> = { acme: acme.id, 'northline-shop': northline.id };
  for (const c of CREDENTIALS) {
    await prisma.vendorCredential.upsert({
      where: { keyId: c.keyId },
      update: { secret: c.secret, vendor: c.vendor, workspaceId: slugToId[c.workspaceSlug], active: true },
      create: {
        keyId: c.keyId,
        vendor: c.vendor,
        secret: c.secret,
        workspaceId: slugToId[c.workspaceSlug],
      },
    });
  }

  await seedWorkspaceItems(acme.id, acmeItems);
  await seedWorkspaceItems(northline.id, northlineItems);

  /* eslint-disable no-console */
  console.log('\nSeed complete.\n');
  console.log(`Accounts (JWT login — password for all: "${SEED_PASSWORD}"):`);
  console.log(`  Alice  alice@acme.test        role=ops-admin  (read + retry)   -> workspace: acme`);
  console.log(`  Bob    bob@northline.test     role=ops-viewer (read only)       -> workspace: northline-shop`);
  console.log('\nWorkspace URLs:');
  console.log('  http://localhost:3000/w/acme/events');
  console.log('  http://localhost:3000/w/northline-shop/events');
  console.log('\nVendor signing credentials (also in scripts/webhook.sh):');
  for (const c of CREDENTIALS) {
    console.log(`  keyId=${c.keyId}  vendor=${c.vendor}  workspace=${c.workspaceSlug}  secret=${c.secret}`);
  }
  console.log('');
  /* eslint-enable no-console */
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
