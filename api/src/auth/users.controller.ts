import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PrismaService } from '../prisma.service';
import { Role } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async list(@Req() req: any) {
    if (req.user.role !== Role.ADMIN)
      throw new ForbiddenException('Admins only');
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        createdAt: true,
      },
    });
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    if (req.user.role !== Role.ADMIN)
      throw new ForbiddenException('Admins only');
    if (req.user.userId === id)
      throw new ForbiddenException('You cannot delete your own account');
    await this.prisma.user.delete({ where: { id } });
    return { ok: true };
  }
}
