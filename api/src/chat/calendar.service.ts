import { Injectable, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DateTime } from 'luxon';
import * as chrono from 'chrono-node';
import { PrismaService } from '../prisma.service';

const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;

// the parser ignores a bare day of the month ("the 23rd", "the 5th of next
// month"), so those become an explicit "September 23" first — this month if
// the day hasn't passed, otherwise next month
export function normalizeWhen(when: string, now: DateTime): string {
  let s = when.trim();
  if (MONTHS.test(s)) return s; // "June 7th", "the 7th of June" — already explicit
  const nextMonth = /\bnext\s+month\b/i.test(s);
  s = s.replace(/\bnext\s+month\b/i, '');
  s = s.replace(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b(?:\s+of)?/i, (_m, d: string) => {
    const day = parseInt(d, 10);
    if (day < 1 || day > 31) return _m;
    let m = now;
    if (nextMonth || day < now.day) m = now.plus({ months: 1 });
    return `${m.toFormat('MMMM')} ${day}`;
  });
  return s.replace(/\s+/g, ' ').trim();
}

export interface EventInput {
  title: string;
  when?: string; // natural language, as the person said it: "Saturday at 10am"
  start?: string; // or a local wall-clock ISO, e.g. 2026-09-20T10:00 / 2026-09-20 for all-day
  end?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
  who?: string;
}

@Injectable()
export class CalendarService {
  constructor(private prisma: PrismaService) {}

  // the family's timezone: an admin setting, else whatever the server runs in
  async zone(): Promise<string> {
    const s = await this.prisma.setting.findUnique({ where: { key: 'timezone' } });
    return s?.value || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  async now() {
    return DateTime.now().setZone(await this.zone());
  }

  async add(createdBy: string, input: EventInput) {
    const zone = await this.zone();
    const title = String(input.title ?? '').trim().slice(0, 120);
    if (!title) throw new BadRequestException('An event needs a title');
    let start: DateTime | null = null;
    let end: DateTime | null = null;
    let allDay = !!input.allDay;

    // small models are bad at calendar arithmetic ("Saturday" → wrong day), so
    // the person's own words are parsed here, relative to right now in the
    // family's timezone, always looking forward
    if (input.when?.trim()) {
      const ref = DateTime.now().setZone(zone);
      const text = normalizeWhen(input.when, ref);
      const [hit] = chrono.parse(
        text,
        { instant: ref.toJSDate(), timezone: zone },
        { forwardDate: true },
      );
      // a time alone ("9:00 AM") with other date-ish words we couldn't read
      // must not silently become "tomorrow at 9" — better to ask
      const datePart = !!hit && (hit.start.isCertain('day') || hit.start.isCertain('weekday'));
      const leftover = hit ? text.replace(hit.text, '') : text;
      if (hit && (datePart || !/\d|\b(next|last|this)\b/i.test(leftover))) {
        start = DateTime.fromJSDate(hit.start.date()).setZone(zone);
        allDay = allDay || !hit.start.isCertain('hour');
        if (hit.end) end = DateTime.fromJSDate(hit.end.date()).setZone(zone);
      }
    }
    if (!start && input.start) {
      allDay = allDay || /^\d{4}-\d{2}-\d{2}$/.test(String(input.start));
      const s = DateTime.fromISO(String(input.start), { zone });
      if (s.isValid) start = s;
      if (input.end) {
        const e = DateTime.fromISO(String(input.end), { zone });
        if (e.isValid) end = e;
      }
    }
    if (!start) {
      throw new BadRequestException(`Couldn't understand the date "${input.when ?? input.start ?? ''}"`);
    }
    if (!allDay && !end) end = start.plus({ hours: 1 });
    return this.prisma.event.create({
      data: {
        title,
        startsAt: (allDay ? start.startOf('day') : start).toJSDate(),
        endsAt: allDay ? null : end!.toJSDate(),
        allDay,
        location: input.location?.trim().slice(0, 200) || null,
        notes: input.notes?.trim().slice(0, 500) || null,
        who: input.who?.trim().slice(0, 80) || null,
        createdBy,
      },
    });
  }

  async list(fromISO?: string, toISO?: string) {
    const zone = await this.zone();
    const from = fromISO ? DateTime.fromISO(fromISO, { zone }) : DateTime.now().setZone(zone).startOf('day');
    const to = toISO ? DateTime.fromISO(toISO, { zone }).endOf('day') : from.plus({ days: 30 });
    return this.prisma.event.findMany({
      where: { startsAt: { gte: from.toJSDate(), lte: to.toJSDate() } },
      orderBy: { startsAt: 'asc' },
    });
  }

  async remove(id: string) {
    await this.prisma.event.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  }

  // human-friendly lines for the assistant and the ics feed
  async describe(events: { title: string; startsAt: Date; endsAt: Date | null; allDay: boolean; location: string | null; who: string | null; id: string }[]) {
    const zone = await this.zone();
    return events.map((e) => {
      const s = DateTime.fromJSDate(e.startsAt).setZone(zone);
      const when = e.allDay
        ? s.toFormat('EEE MMM d') + ' (all day)'
        : s.toFormat('EEE MMM d, h:mm a') +
          (e.endsAt ? '–' + DateTime.fromJSDate(e.endsAt).setZone(zone).toFormat('h:mm a') : '');
      return { id: e.id, when, title: e.title, location: e.location, who: e.who };
    });
  }

  // the secret in the phone-subscription url; created once, admins can rotate it
  async feedKey(): Promise<string> {
    const s = await this.prisma.setting.findUnique({ where: { key: 'calendar_key' } });
    if (s?.value) return s.value;
    const key = randomBytes(18).toString('hex');
    await this.prisma.setting.upsert({
      where: { key: 'calendar_key' },
      create: { key: 'calendar_key', value: key },
      update: { value: key },
    });
    return key;
  }

  // icalendar feed: what apple/google calendar subscribe to
  async ics(): Promise<string> {
    const events = await this.prisma.event.findMany({
      where: { startsAt: { gte: DateTime.now().minus({ days: 90 }).toJSDate() } },
      orderBy: { startsAt: 'asc' },
    });
    const fmt = (d: Date) => DateTime.fromJSDate(d).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
    const day = (d: Date, zone: string) => DateTime.fromJSDate(d).setZone(zone).toFormat('yyyyLLdd');
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
    const zone = await this.zone();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Circuit Barn//Family Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Family (Circuit Barn)',
      `X-WR-TIMEZONE:${zone}`,
      'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
      'X-PUBLISHED-TTL:PT15M',
    ];
    for (const e of events) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${e.id}@circuit-barn`);
      lines.push(`DTSTAMP:${fmt(e.createdAt)}`);
      if (e.allDay) {
        lines.push(`DTSTART;VALUE=DATE:${day(e.startsAt, zone)}`);
        lines.push(`DTEND;VALUE=DATE:${DateTime.fromJSDate(e.startsAt).setZone(zone).plus({ days: 1 }).toFormat('yyyyLLdd')}`);
      } else {
        lines.push(`DTSTART:${fmt(e.startsAt)}`);
        lines.push(`DTEND:${fmt(e.endsAt ?? new Date(e.startsAt.getTime() + 3600_000))}`);
      }
      lines.push(`SUMMARY:${esc(e.who ? `${e.title} (${e.who})` : e.title)}`);
      if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
      if (e.notes) lines.push(`DESCRIPTION:${esc(e.notes)}`);
      if (!e.allDay) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT1H', `DESCRIPTION:${esc(e.title)}`, 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }
}
