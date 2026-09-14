import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Role } from '@prisma/client';

class LoginDto {
  @IsString() @IsNotEmpty() username: string;
  @IsString() @IsNotEmpty() password: string;
}

class RegisterDto {
  @IsString() @IsNotEmpty() username: string;
  @IsString() @IsNotEmpty() displayName: string;
  @IsString() @MinLength(6) password: string;
  @IsIn(['ADMIN', 'ADULT', 'CHILD']) role: Role;
}

// the login page can be reachable from the internet (tailscale funnel), so
// slow down password guessing. keyed on the account (10 failures / 15 min)
// with a looser per-address cap, because behind the ui's proxy every visitor
// can look like the same address and one bad actor must not lock out the house.
const WINDOW = 15 * 60_000;
const attempts = new Map<string, { n: number; until: number }>();
function tooMany(key: string, limit: number) {
  const a = attempts.get(key);
  return !!a && a.n >= limit && Date.now() < a.until;
}
function checkLoginRate(ip: string, username: string) {
  if (tooMany(`user:${username}`, 10) || tooMany(`ip:${ip}`, 60)) {
    throw new HttpException('Too many attempts — try again in a few minutes', 429);
  }
}
function noteLoginFailure(ip: string, username: string) {
  const now = Date.now();
  for (const key of [`user:${username}`, `ip:${ip}`]) {
    const a = attempts.get(key);
    if (!a || now > a.until) attempts.set(key, { n: 1, until: now + WINDOW });
    else a.n += 1;
  }
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Get('bootstrap-needed')
  async bootstrapNeeded() {
    return { needed: await this.auth.bootstrapNeeded() };
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: any) {
    const ip = String(req.headers['x-forwarded-for'] ?? req.ip ?? 'unknown').split(',')[0].trim();
    const username = dto.username.toLowerCase().trim();
    checkLoginRate(ip, username);
    try {
      return await this.auth.login(username, dto.password);
    } catch (e) {
      noteLoginFailure(ip, username);
      throw e;
    }
  }

  @Post('register')
  register(@Body() dto: RegisterDto, @Headers('authorization') authz?: string) {
    const token = authz?.startsWith('Bearer ') ? authz.slice(7) : null;
    const caller = token ? this.auth.verifyToken(token) : null;
    return this.auth.register(
      caller,
      dto.username,
      dto.displayName,
      dto.password,
      dto.role,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: any) {
    return req.user;
  }
}
