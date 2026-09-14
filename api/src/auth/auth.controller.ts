import {
  Body,
  Controller,
  Get,
  Headers,
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

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Get('bootstrap-needed')
  async bootstrapNeeded() {
    return { needed: await this.auth.bootstrapNeeded() };
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.username.toLowerCase().trim(), dto.password);
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
