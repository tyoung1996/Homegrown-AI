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
  sourceText?: string; // the person's whole message — the ground truth for dates
  when?: string; // the model's version of the date words (it sometimes rewrites them wrongly)
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

    // small models are bad with dates: they miscount weekdays and sometimes
    // rewrite "the 23rd" into a wrong explicit date. so the person's own
    // message is parsed first and wins whenever it contains a date; the
    // model's version is only a fallback.
    const ref = DateTime.now().setZone(zone);
    const fromMessage = input.sourceText ? this.resolve(input.sourceText, ref, zone, input.when) : null;
    const fromModel = input.when ? this.resolve(input.when, ref, zone) : null;
    const pick = fromMessage?.hasDate ? fromMessage : fromModel?.hasDate ? fromModel : fromMessage ?? fromModel;
    if (pick) {
      if (!pick.hasDate && pick.ambiguous) {
        throw new BadRequestException('Which day is that? I found a time but no date.');
      }
      start = pick.start;
      end = pick.end;
      allDay = allDay || pick.allDay;
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

  // parse a piece of text into one start/end. the parser often splits
  // "at 9:00 AM on September 23" into a time hit and a date hit, so hits
  // get merged: the date from a day-certain hit, the clock from an hour-
  // certain one. when the text holds several dates (two events in one
  // sentence), `hint` — the model's words for this event — picks the one
  // whose text overlaps it best.
  private resolve(raw: string, ref: DateTime, zone: string, hint?: string) {
    const text = normalizeWhen(raw, ref);
    const hits = chrono.parse(text, { instant: ref.toJSDate(), timezone: zone }, { forwardDate: true });
    if (!hits.length) return null;
    const dated = hits.filter((h) => h.start.isCertain('day') || h.start.isCertain('weekday'));
    const timed = hits.filter((h) => h.start.isCertain('hour'));
    const overlap = (a: string, b: string) => {
      const ta = new Set(a.toLowerCase().match(/[a-z0-9:]+/g) ?? []);
      return (b.toLowerCase().match(/[a-z0-9:]+/g) ?? []).filter((w) => ta.has(w)).length;
    };
    let dateHit = dated[0] ?? null;
    if (dated.length > 1 && hint) {
      dateHit = [...dated].sort((a, b) => overlap(hint, b.text) - overlap(hint, a.text))[0];
    }
    // the clock that belongs to this date: same hit if it has one, else the
    // nearest time-only hit in the text
    let timeHit = dateHit && dateHit.start.isCertain('hour') ? dateHit : null;
    if (!timeHit && timed.length) {
      const pos = dateHit ? dateHit.index : 0;
      timeHit = [...timed].sort((a, b) => Math.abs(a.index - pos) - Math.abs(b.index - pos))[0];
    }
    const base = dateHit ?? timeHit ?? hits[0];
    let start = DateTime.fromJSDate(base.start.date()).setZone(zone);
    if (dateHit && timeHit && timeHit !== dateHit) {
      const t = DateTime.fromJSDate(timeHit.start.date()).setZone(zone);
      start = start.set({ hour: t.hour, minute: t.minute, second: 0, millisecond: 0 });
    }
    const allDay = !timeHit;
    let end: DateTime | null = null;
    const endSrc = timeHit?.end ?? dateHit?.end ?? null;
    if (endSrc) end = DateTime.fromJSDate(endSrc.date()).setZone(zone);
    // digits or "next/this" left over that no hit covered = something we
    // failed to read, so a bare time shouldn't be trusted
    const leftover = hits.reduce((s, h) => s.replace(h.text, ''), text);
    const ambiguous = /\d|\b(next|last|this)\b/i.test(leftover);
    return { start, end, allDay, hasDate: !!dateHit, ambiguous };
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
