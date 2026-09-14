import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma.service';
import { Role } from '@prisma/client';

export interface CallerInfo {
  userId: string;
  role: Role;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async bootstrapNeeded(): Promise<boolean> {
    return (await this.prisma.user.count()) === 0;
  }

  async login(username: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { username } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Wrong username or password');
    }
    return this.issueToken(user.id, user.username, user.role, user.displayName);
  }

  // first account ever created becomes the admin; after that it's invite-only
  async register(
    caller: CallerInfo | null,
    username: string,
    displayName: string,
    password: string,
    role: Role,
  ) {
    const isBootstrap = await this.bootstrapNeeded();
    if (!isBootstrap && caller?.role !== Role.ADMIN) {
      throw new ForbiddenException('Only an admin can create accounts');
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.prisma.user.create({
      data: {
        username: username.toLowerCase().trim(),
        displayName,
        passwordHash,
        role: isBootstrap ? Role.ADMIN : role,
      },
    });
    return this.issueToken(user.id, user.username, user.role, user.displayName);
  }

  verifyToken(token: string): CallerInfo | null {
    try {
      const p = this.jwt.verify(token);
      return { userId: p.sub, role: p.role };
    } catch {
      return null;
    }
  }

  private issueToken(sub: string, username: string, role: Role, displayName: string) {
    return {
      token: this.jwt.sign({ sub, username, role }),
      user: { id: sub, username, role, displayName },
    };
  }
}
