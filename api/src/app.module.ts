import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { config } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/jwt/jwt.guard';
import { PermissionsGuard } from './auth/permission/permission.guard';
import { WorkItemsModule } from './workitems/work-items.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { HealthController } from './health.controller';
import { ResponseInterceptor } from './common/response.interceptor';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [config],
      envFilePath: `.env.${process.env.NODE_ENV || 'development'}`,
    }),
    JwtModule.register({ global: true }),
    PrismaModule,
    AuthModule,
    WorkItemsModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global auth: authenticate first, then authorize by permission.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Consistent success envelope + status-preserving error envelope.
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
