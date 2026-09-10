import * as dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 7 moved the datasource connection URL out of schema.prisma.
// Load the same per-environment file the app uses.
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` });

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
