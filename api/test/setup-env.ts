import * as dotenv from 'dotenv';

// Jest sets NODE_ENV=test; the e2e suite runs against the development database.
dotenv.config({ path: '.env.development' });
