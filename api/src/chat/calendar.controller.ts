import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CalendarService } from './calendar.service';
// type-only: a decorated signature cannot use a value import under isolatedModules
import type { EventInput } from './calendar.service';

@UseGuards(JwtAuthGuard)
@Controller('calendar')
export class CalendarController {
  constructor(private cal: CalendarService) {}

  @Get()
  async list(@Query('from') from?: string, @Query('to') to?: string) {
    const [events, zone] = await Promise.all([this.cal.list(from, to), this.cal.zone()]);
    return { zone, events };
  }

  @Post()
  add(@Req() req: any, @Body() body: EventInput) {
    return this.cal.add(req.user.userId, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.cal.remove(id);
  }

  // the phone-subscription link (secret key inside); shown in the calendar page
  @Get('subscribe')
  async subscribe(@Req() req: any) {
    const key = await this.cal.feedKey();
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:3000').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
    const path = `/api/calendar/feed/${key}.ics`;
    return { https: `${proto}://${host}${path}`, webcal: `webcal://${host}${path}` };
  }
}

// no login on the feed itself — calendar apps can't log in — the long random
// key in the url is the secret
@Controller('calendar/feed')
export class CalendarFeedController {
  constructor(private cal: CalendarService) {}

  @Get(':key.ics')
  @Header('content-type', 'text/calendar; charset=utf-8')
  @Header('cache-control', 'no-cache')
  async feed(@Param('key') key: string) {
    if (key !== (await this.cal.feedKey())) throw new NotFoundException();
    return this.cal.ics();
  }
}
