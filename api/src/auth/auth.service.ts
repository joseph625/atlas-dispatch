import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Response } from 'express';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload, MembershipClaim } from './types/auth-user.types';

export const REFRESH_COOKIE = 'atlas_refresh';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Build the full JWT principal for a user in ONE set of queries: permissions
   * (from roles) + membership claims (tenant access). Guards then read both from
   * the decoded token instead of querying the DB on every request.
   */
  private async buildPrincipal(userId: string): Promise<JwtPayload> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: {
          include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
        },
        memberships: { include: { workspace: true } },
      },
    });
    if (!user) throw new UnauthorizedException('user gone');

    const permissions = new Set<string>();
    for (const ur of user.userRoles) {
      for (const rp of ur.role.rolePermissions) permissions.add(rp.permission.name);
    }
    const memberships: MembershipClaim[] = user.memberships.map((m) => ({
      workspaceId: m.workspaceId,
      slug: m.workspace.slug,
      name: m.workspace.name,
      role: m.role,
    }));

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      permissions: [...permissions],
      memberships,
    };
  }

  private signAccess(principal: JwtPayload): Promise<string> {
    return this.jwt.signAsync(principal, {
      secret: this.config.get<string>('accessSecret'),
      expiresIn: this.ttl('accessTokenTtl'),
    });
  }

  // @nestjs/jwt types expiresIn as number | ms.StringValue; config returns a
  // plain string, so widen it at the call sites.
  private ttl(key: 'accessTokenTtl' | 'refreshTokenTtl'): number {
    return this.config.get<string>(key) as unknown as number;
  }

  private ttlToMs(ttl: string): number {
    const value = parseFloat(ttl);
    const unit = ttl.replace(/[\d.]/g, '').toLowerCase();
    const table: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return value * (table[unit] ?? 86_400_000);
  }

  async login(email: string, password: string, response: Response) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Uniform error to avoid revealing which half was wrong (user enumeration).
    const invalid = () => new UnauthorizedException('invalid credentials');
    if (!user) throw invalid();
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw invalid();

    const principal = await this.buildPrincipal(user.id);
    const accessToken = await this.signAccess(principal);
    const refreshToken = await this.jwt.signAsync(
      { id: user.id },
      { secret: this.config.get<string>('refreshSecret'), expiresIn: this.ttl('refreshTokenTtl') },
    );

    // Rotate: revoke prior refresh tokens, persist the new one.
    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revoked: false },
      data: { revoked: true },
    });
    const expiresAt = new Date(
      Date.now() + this.ttlToMs(this.config.get<string>('refreshTokenTtl')!),
    );
    await this.prisma.refreshToken.create({
      data: { userId: user.id, token: refreshToken, expiresAt },
    });

    response.cookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: this.config.get<string>('nodeEnv') === 'production',
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });

    return {
      message: 'Login successful',
      data: {
        accessToken,
        user: { id: principal.id, email: principal.email, name: principal.name },
        permissions: principal.permissions,
      },
    };
  }

  async logout(refreshToken: string | undefined, response: Response) {
    if (refreshToken) {
      await this.prisma.refreshToken.updateMany({
        where: { token: refreshToken, revoked: false },
        data: { revoked: true },
      });
    }
    response.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { message: 'Logout successful' };
  }

  async refresh(refreshToken: string | undefined) {
    if (!refreshToken) throw new UnauthorizedException('no refresh token');

    let decoded: { id: string };
    try {
      decoded = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('refreshSecret'),
      });
    } catch {
      await this.prisma.refreshToken.updateMany({
        where: { token: refreshToken },
        data: { revoked: true },
      });
      throw new UnauthorizedException('invalid refresh token');
    }

    const stored = await this.prisma.refreshToken.findFirst({
      where: {
        token: refreshToken,
        userId: decoded.id,
        revoked: false,
        expiresAt: { gt: new Date() },
      },
    });
    if (!stored) throw new UnauthorizedException('refresh token not recognised');

    // Re-mint the access token with fresh permissions + memberships.
    const principal = await this.buildPrincipal(decoded.id);
    const accessToken = await this.signAccess(principal);
    return {
      message: 'Token refreshed',
      data: { accessToken, permissions: principal.permissions },
    };
  }
}
