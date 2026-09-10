interface ConfigProps {
  nodeEnv: string;
  apiPort: number;
  accessSecret: string;
  refreshSecret: string;
  accessTokenTtl: string;
  refreshTokenTtl: string;
}

export const config = (): ConfigProps => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  apiPort: Number(process.env.API_PORT ?? 3333),
  accessSecret: process.env.ACCESS_SECRET_KEY || 'dev_access_secret_change_me',
  refreshSecret: process.env.REFRESH_SECRET_KEY || 'dev_refresh_secret_change_me',
  accessTokenTtl: process.env.JWT_ACCESS_TOKEN_EXPIRATION_TIME || '5m',
  refreshTokenTtl: process.env.JWT_REFRESH_TOKEN_EXPIRATION_TIME || '7d',
});
