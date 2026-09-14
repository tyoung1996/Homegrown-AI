import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { UsersController } from './users.controller';
import { SettingsController } from './settings.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '30d' },
    }),
  ],
  controllers: [AuthController, UsersController, SettingsController],
  providers: [AuthService, JwtStrategy, PrismaService],
  exports: [AuthService],
})
export class AuthModule {}
