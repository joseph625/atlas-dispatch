import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MeController } from './me.controller';
import { DevController } from './dev.controller';
import { AuthGuard } from './jwt/jwt.guard';
import { PermissionsGuard } from './permission/permission.guard';
import { WorkspaceGuard } from './workspace.guard';

@Module({
  controllers: [AuthController, MeController, DevController],
  providers: [AuthService, AuthGuard, PermissionsGuard, WorkspaceGuard],
  exports: [AuthGuard, PermissionsGuard, WorkspaceGuard],
})
export class AuthModule {}
