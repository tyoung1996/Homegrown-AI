import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PrismaService } from '../prisma.service';
import { Role } from '@prisma/client';

// app-wide knobs an admin can turn from the ui
const EDITABLE = ['persona'] as const;
const MAX_LEN = 2000;

@UseGuards(JwtAuthGuard)
@Controller('settings')
export class SettingsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async get(@Req() req: any) {
    if (req.user.role !== Role.ADMIN) throw new ForbiddenException('Admins only');
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: [...EDITABLE] } },
    });
    const out: Record<string, string> = {};
    for (const k of EDITABLE) out[k] = rows.find((r) => r.key === k)?.value ?? '';
    return out;
  }

  @Post()
  async set(@Req() req: any, @Body() body: Record<string, unknown>) {
    if (req.user.role !== Role.ADMIN) throw new ForbiddenException('Admins only');
    for (const k of EDITABLE) {
      if (typeof body[k] !== 'string') continue;
      const value = (body[k] as string).slice(0, MAX_LEN);
      await this.prisma.setting.upsert({
        where: { key: k },
        create: { key: k, value },
        update: { value },
      });
    }
    return this.get(req);
  }
}
