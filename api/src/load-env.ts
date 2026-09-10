import * as dotenv from 'dotenv';

// Loaded as the very first import in main.ts so env vars exist before any module
// (PrismaService, ConfigService, webhook constants) reads process.env.
// Selects the file by NODE_ENV, defaulting to development.
const env = process.env.NODE_ENV || 'development';
dotenv.config({ path: `.env.${env}` });
