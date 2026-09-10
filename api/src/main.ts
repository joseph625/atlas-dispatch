import './load-env'; // must be first: populates process.env from .env.<NODE_ENV>
import 'reflect-metadata';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as express from 'express';
import { json } from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AppLogger } from './common/logger';

const MAX_BODY_BYTES = Number(process.env.WEBHOOK_MAX_BODY_BYTES ?? 65536);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: new AppLogger(),
  });

  // Capture exact raw bytes so HMAC verification signs what the vendor signed.
  // The size limit here is what rejects oversized bodies (Express replies 413).
  app.use(
    json({
      limit: MAX_BODY_BYTES,
      type: () => true,
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  app.enableCors({ origin: true, credentials: true });

  // App API lives under /api. The vendor ingest path and health stay at the
  // root so the take-home's documented `POST /webhooks/:vendor` is exact.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'webhooks/:vendor', method: RequestMethod.POST },
      { path: 'health', method: RequestMethod.GET },
    ],
  });

  // Protect the Swagger UI + JSON with HTTP Basic auth (credentials from env).
  const swaggerUser = process.env.SWAGGER_USER || 'admin';
  const swaggerPassword = process.env.SWAGGER_PASSWORD || 'admin';
  app.use(
    ['/docs', '/docs-json'],
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
      if (scheme === 'Basic' && encoded) {
        const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
        if (user === swaggerUser && pass === swaggerPassword) return next();
      }
      res
        .set('WWW-Authenticate', 'Basic realm="Atlas API docs"')
        .status(401)
        .send('Authentication required');
    },
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Northline Atlas Dispatch API')
    .setDescription('Signed ingest + tenant-scoped ops API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = Number(process.env.API_PORT ?? 3333);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[atlas-api] listening on http://localhost:${port} (docs at /docs)`);
}

bootstrap();
