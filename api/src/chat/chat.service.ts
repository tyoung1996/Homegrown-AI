import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ToolsService, TOOL_DEFS } from './tools.service';
import { ComfyService, IMAGES_DIR } from './comfy.service';
import { CalendarService } from './calendar.service';
import { MediaService, MediaRequestView } from '../media/media.service';
import { savePhoto } from './photos';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.CHAT_MODEL ?? 'qwen3:8b';
const VISION_MODEL = process.env.VISION_MODEL ?? 'qwen2.5vl:7b';
const MAX_TOOL_ROUNDS = 3;
// the library tools, hidden when no catalogue key is configured
const MEDIA_TOOL_NAMES = [
  'search_movies',
  'request_movies',
  'search_series',
  'get_series_seasons',
  'get_season_episodes',
  'request_series',
  'request_episodes',
  'get_media_request_status',
];

export type StreamEvent =
  | { type: 'meta'; conversationId: string }
  | { type: 'status'; text: string }
  | { type: 'token'; text: string }
  | { type: 'image'; url: string }
  | { type: 'sources'; urls: string[] }
  // a thing the family taps: pick films, seasons or episodes to add
  | { type: 'picker'; picker: MediaPicker }
  // what a reply just put on the library list
  | { type: 'requests'; requests: MediaRequestView[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

// the shapes the chat can hand to the ui to be tapped on
export type MediaPicker =
  | {
      mode: 'movies';
      query: string;
      items: {
        catalogId: number;
        title: string;
        year?: number;
        overview?: string;
        posterUrl?: string;
        inLibrary: boolean;
        requested: boolean;
      }[];
    }
  | {
      mode: 'series';
      query: string;
      items: {
        catalogId: number;
        title: string;
        year?: number;
        overview?: string;
        posterUrl?: string;
        inLibrary: boolean;
        requested: boolean;
      }[];
    };

// what an assistant message can carry besides its text
export type MessageAttachment =
  { picker: MediaPicker } | { requests: MediaRequestView[] };

// tool arguments come back as loose json from the model — read them
// defensively rather than trusting the shape
function numberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((v) => Number(v)).filter((n) => Number.isFinite(n))
    : [];
}

function episodeList(value: unknown): { season: number; episode: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const e = (raw ?? {}) as { season?: unknown; episode?: unknown };
      return { season: Number(e.season), episode: Number(e.episode) };
    })
    .filter((e) => Number.isFinite(e.season) && Number.isFinite(e.episode));
}

interface OllamaMsg {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: any } }[];
  tool_name?: string;
}

const BASE_PROMPT =
  'You are this family\'s private AI assistant, running on their own home server (the software is called Circuit Barn). ' +
  'If your memories include a name the family gave you, that IS your name — use it. ' +
  'You talk to a family including children, so always be warm, clear, and family-friendly. ' +
  'You have tools: add_event / list_events / delete_event for the shared family calendar — whenever someone mentions a plan with a date (a game, an appointment, a party, a trip), add it, and always confirm back the exact day and time; answer "what\'s coming up" questions from list_events; ' +
  'generate_image to create pictures when someone asks you to draw, paint, or make an image; ' +
  'remember to permanently save lasting facts people tell you (names, birthdays, preferences — always save these); ' +
  'search_movies / search_series whenever someone wants a film or show added to the family library — never guess which title they meant, show them the matches and let them pick; request_movies / request_series / request_episodes once they have chosen or when they say which ones ("the first three", "seasons two and three"); get_media_request_status to say how far along something is; ' +
  'get_weather for any weather question; get_sports_scores for any game score; web_search for current events, prices, or anything you are not certain about; web_fetch to read a page. ' +
  'IMPORTANT: never tell the user to visit a website or check a source themselves — that is your job. ' +
  'If search snippets do not contain the actual answer, call web_fetch on the most promising result and extract it. ' +
  'Always give the concrete answer directly. When you used the web, mention where the information came from. Answer in Markdown.';

@Injectable()
export class ChatService {
  private log = new Logger('Chat');

  constructor(
    private prisma: PrismaService,
    private tools: ToolsService,
    private comfy: ComfyService,
    private calendar: CalendarService,
    private media: MediaService,
  ) {}

  listConversations(userId: string) {
    return this.prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, updatedAt: true },
    });
  }

  async getMessages(userId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        role: true,
        content: true,
        imagePath: true,
        data: true,
        createdAt: true,
      },
    });
  }

  async deleteConversation(userId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    await this.prisma.conversation.delete({ where: { id: conversationId } });
    return { ok: true };
  }

  async sendStream(
    userId: string,
    message: string,
    conversationId: string | undefined,
    imageData: string | undefined,
    emit: (ev: StreamEvent) => void,
  ) {
    let convo = conversationId
      ? await this.prisma.conversation.findFirst({
          where: { id: conversationId, userId },
        })
      : null;
    if (conversationId && !convo)
      throw new NotFoundException('Conversation not found');
    if (!convo) {
      convo = await this.prisma.conversation.create({
        data: { userId, title: message.slice(0, 60) },
      });
    }
    emit({ type: 'meta', conversationId: convo.id });

    // an attached photo gets normalized, written to disk and linked to the message
    let uploadedImage: string | null = null;
    if (imageData) {
      try {
        uploadedImage = await savePhoto(imageData);
      } catch (e: any) {
        emit({ type: 'error', message: e.message ?? 'Could not read that photo' });
        return;
      }
    }

    await this.prisma.message.create({
      data: {
        conversationId: convo.id,
        role: 'user',
        content: message,
        imagePath: uploadedImage,
      },
    });

    if (uploadedImage) {
      return this.handleImageMessage(userId, convo.id, message, uploadedImage, emit);
    }

    const history = await this.prisma.message.findMany({
      where: { conversationId: convo.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    history.reverse();

    const messages: OllamaMsg[] = [
      { role: 'system', content: await this.buildSystemPrompt(userId, convo.id) },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    // fresh installs have no model yet — point people at setup instead of erroring
    if (!(await this.modelReady())) {
      emit({
        type: 'error',
        message:
          'No AI model is installed on this server yet — an admin can install one from the Models panel.',
      });
      return;
    }

    const sources = new Set<string>();
    let finalText = '';
    let generatedImage: string | null = null;
    // anything the reply carries besides text (a picker, a list of things
    // just added) — shown as it happens and kept with the message
    let attachment: MessageAttachment | null = null;
    let tools = (await this.comfyReady())
      ? TOOL_DEFS
      : TOOL_DEFS.filter((t) => t.function.name !== 'generate_image');
    // no catalogue key on this server means no library requests to offer
    if (!(await this.media.health()).catalog.configured) {
      tools = tools.filter((t) => !MEDIA_TOOL_NAMES.includes(t.function.name));
    }

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const lastRound = round === MAX_TOOL_ROUNDS;
        const { content, toolCalls } = await this.ollamaRound(
          messages,
          lastRound ? undefined : tools,
          (tok) => emit({ type: 'token', text: tok }),
        );

        if (!toolCalls.length) {
          finalText = content;
          break;
        }

        messages.push({ role: 'assistant', content, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          const name = tc.function.name;
          const args =
            typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments || '{}')
              : (tc.function.arguments ?? {});
          let result = '';
          if (name === 'add_event') {
            emit({ type: 'status', text: 'Adding it to the family calendar' });
            this.log.log(`add_event ${JSON.stringify(args)}`);
            try {
              const ev = await this.calendar.add(userId, {
                title: String(args.title ?? ''),
                sourceText: message,
                when: args.when ? String(args.when) : undefined,
                start: args.start ? String(args.start) : undefined,
                end: args.end ? String(args.end) : undefined,
                allDay: !!args.allDay,
                location: args.location ? String(args.location) : undefined,
                who: args.who ? String(args.who) : undefined,
                notes: args.notes ? String(args.notes) : undefined,
              });
              const [d] = await this.calendar.describe([ev]);
              result = `Added: ${d.title} — ${d.when}${d.location ? ' at ' + d.location : ''}${d.who ? ' (for ' + d.who + ')' : ''}. Confirm this to the user in one friendly line, including the day and time.`;
            } catch (e: any) {
              result = `Could not add it: ${e.message}. Ask the user for the missing detail.`;
            }
          } else if (name === 'list_events') {
            emit({ type: 'status', text: 'Checking the family calendar' });
            const events = await this.calendar.list(
              args.from ? String(args.from) : undefined,
              args.to ? String(args.to) : undefined,
            );
            const lines = await this.calendar.describe(events);
            result = lines.length
              ? JSON.stringify(lines)
              : 'Nothing on the calendar in that range.';
          } else if (name === 'delete_event') {
            emit({ type: 'status', text: 'Updating the family calendar' });
            await this.calendar.remove(String(args.id ?? ''));
            result = 'Removed. Confirm to the user.';
          } else if (name === 'generate_image') {
            const p = String(args.prompt ?? '');
            emit({ type: 'status', text: `Painting: ${p.slice(0, 80)}` });
            try {
              generatedImage = await this.comfy.generate(p);
              emit({ type: 'image', url: `/images/${generatedImage}` });
              await this.prisma.imageGeneration.create({
                data: { userId, prompt: p, status: 'done', filePath: generatedImage },
              });
              result =
                'The image was created and is already displayed to the user. Reply with one short, warm sentence about it. Do not include a link or markdown image.';
            } catch (e: any) {
              this.log.error(`image gen failed: ${e.message}`);
              result = 'Image generation failed. Apologize briefly.';
            }
          } else if (name === 'search_movies' || name === 'search_series') {
            const isSeries = name === 'search_series';
            const query = String(args.query ?? '').trim();
            emit({
              type: 'status',
              text: `Looking up ${query || (isSeries ? 'that show' : 'that film')}`,
            });
            try {
              const items = isSeries
                ? await this.media.searchSeries(query)
                : await this.media.searchMovies(query);
              if (!items.length) {
                result = `Nothing found for "${query}". Ask them to try another title.`;
              } else {
                const picker = {
                  mode: isSeries ? ('series' as const) : ('movies' as const),
                  query,
                  items,
                };
                attachment = { picker };
                emit({ type: 'picker', picker });
                result =
                  JSON.stringify(
                    items.map((i) => ({
                      catalogId: i.catalogId,
                      title: i.title,
                      year: i.year,
                      inLibrary: i.inLibrary,
                      requested: i.requested,
                    })),
                  ) +
                  ' — these are already shown to the user as tick boxes they can tap. Say in one short line what you found and that they can pick, or ask which ones they want. Do not list them all out again.';
              }
            } catch (e: any) {
              result = `Lookup failed: ${e.message}`;
            }
          } else if (name === 'get_series_seasons') {
            emit({ type: 'status', text: 'Checking the seasons' });
            try {
              const data = await this.media.seasons(Number(args.seriesId));
              result = JSON.stringify({
                series: data.series.title,
                seasons: data.seasons.map((x) => ({
                  season: x.seasonNumber,
                  episodes: x.episodeCount,
                  inLibrary: x.inLibrary,
                })),
              });
            } catch (e: any) {
              result = `Could not read the seasons: ${e.message}`;
            }
          } else if (name === 'get_season_episodes') {
            emit({ type: 'status', text: 'Checking the episodes' });
            try {
              const data = await this.media.episodes(
                Number(args.seriesId),
                Number(args.seasonNumber),
              );
              result = JSON.stringify({
                series: data.series.title,
                episodes: data.episodes.map((x) => ({
                  season: x.seasonNumber,
                  episode: x.episodeNumber,
                  name: x.name,
                  inLibrary: x.inLibrary,
                })),
              });
            } catch (e: any) {
              result = `Could not read the episodes: ${e.message}`;
            }
          } else if (
            name === 'request_movies' ||
            name === 'request_series' ||
            name === 'request_episodes'
          ) {
            emit({ type: 'status', text: 'Adding to the library list' });
            try {
              const outcomes =
                name === 'request_movies'
                  ? await this.media.requestMovies(
                      userId,
                      numberList(args.movieIds),
                    )
                  : name === 'request_series'
                    ? await this.media.requestSeries(
                        userId,
                        Number(args.seriesId),
                        numberList(args.seasons),
                      )
                    : await this.media.requestEpisodes(
                        userId,
                        Number(args.seriesId),
                        episodeList(args.episodes),
                      );
              const queued = outcomes
                .filter((o) => o.result !== 'already-available')
                .map((o) => (o as { request: MediaRequestView }).request)
                .filter(Boolean);
              if (queued.length) {
                attachment = { requests: queued };
                emit({ type: 'requests', requests: queued });
              }
              result =
                JSON.stringify(
                  outcomes.map((o) => ({ item: o.label, outcome: o.result })),
                ) +
                ' — "already-available" means it is on the shelf already, "already-requested" means it was on the list. Confirm warmly in one or two lines.';
            } catch (e: any) {
              result = `Could not add that: ${e.message}`;
            }
          } else if (name === 'get_media_request_status') {
            emit({ type: 'status', text: 'Checking the library list' });
            const all = await this.media.list(userId);
            const q = String(args.query ?? '')
              .toLowerCase()
              .trim();
            const rows = (
              q ? all.filter((r) => r.label.toLowerCase().includes(q)) : all
            ).slice(0, 25);
            result = rows.length
              ? JSON.stringify(
                  rows.map((r) => ({
                    item: r.label,
                    status: r.statusText,
                    note: r.statusNote,
                    askedBy: r.requestedBy,
                  })),
                )
              : 'Nothing on the library list yet.';
          } else if (name === 'remember') {
            emit({ type: 'status', text: 'Saving that to memory' });
            await this.prisma.memory.create({
              data: {
                content: String(args.content ?? ''),
                userId: args.scope === 'family' ? null : userId,
              },
            });
            result = 'Saved. You will know this in every future chat.';
          } else if (name === 'get_weather') {
            emit({
              type: 'status',
              text: `Checking the weather in ${args.location}`,
            });
            result = await this.tools.getWeather(String(args.location ?? ''));
          } else if (name === 'get_sports_scores') {
            emit({
              type: 'status',
              text: `Checking ${String(args.league ?? '').toUpperCase()} scores`,
            });
            result = await this.tools.getScores(
              String(args.league ?? ''),
              args.team ? String(args.team) : undefined,
            );
          } else if (name === 'web_search') {
            emit({ type: 'status', text: `Searching the web: ${args.query}` });
            const found = await this.tools.webSearchDeep(String(args.query ?? ''));
            found.results.forEach((r) => sources.add(r.url));
            result = JSON.stringify(found);
          } else if (name === 'web_fetch') {
            emit({ type: 'status', text: `Reading ${args.url}` });
            sources.add(String(args.url ?? ''));
            result = await this.tools.webFetch(String(args.url ?? ''));
          } else {
            result = `Unknown tool ${name}`;
          }
          messages.push({ role: 'tool', tool_name: name, content: result });
        }
      }
    } catch (e: any) {
      this.log.error(`chat failed: ${e.message}`);
      emit({ type: 'error', message: 'The model backend is not responding' });
      return;
    }

    await this.prisma.message.create({
      data: {
        conversationId: convo.id,
        role: 'assistant',
        content: finalText,
        imagePath: generatedImage,
        // prisma's json input type has no room for named interfaces
        ...(attachment
          ? { data: attachment as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { updatedAt: new Date() },
    });
    if (sources.size) emit({ type: 'sources', urls: [...sources].slice(0, 8) });
    emit({ type: 'done' });
    // learn from the exchange in the background; never delays the reply
    void this.reflect(userId, convo.id).catch((e) => this.log.warn(`reflect: ${e.message}`));
  }

  // after each reply: pull out durable facts about the person and keep a
  // one-line summary of the conversation, so future chats start informed
  private async reflect(userId: string, conversationId: string) {
    const [recent, known] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
      this.prisma.memory.findMany({ where: { userId }, select: { content: true } }),
    ]);
    if (recent.length < 2) return;
    const excerpt = recent
      .reverse()
      .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content.slice(0, 600)}`)
      .join('\n');
    const knownList = known.map((k) => `- ${k.content}`).join('\n') || '(nothing yet)';
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: await this.activeModel(),
        stream: false,
        think: false,
        format: 'json',
        options: { num_ctx: 8192, num_predict: 300, temperature: 0.2 },
        messages: [
          {
            role: 'system',
            content:
              'You maintain long-term memory for a family assistant. From the conversation excerpt, extract durable facts about the USER worth remembering in future conversations: their preferences, family members and pets, school or work, important dates, ongoing plans or situations. Skip trivia, one-off requests, and anything about the assistant. Do not repeat facts already known. Each fact is one short sentence that makes sense on its own. Also write a one-line summary (max 15 words) of what this conversation is about. ' +
              `Already known:\n${knownList}\n` +
              'Reply with JSON only: {"facts": ["..."], "summary": "..."}',
          },
          { role: 'user', content: excerpt },
        ],
      }),
    });
    if (!res.ok) return;
    const data: any = await res.json();
    let parsed: { facts?: unknown; summary?: unknown } = {};
    try {
      parsed = JSON.parse(data.message?.content ?? '{}');
    } catch {
      return;
    }
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const existing = known.map((k) => norm(k.content));
    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    let saved = 0;
    for (const f of facts.slice(0, 3)) {
      if (typeof f !== 'string') continue;
      const fact = f.trim().slice(0, 200);
      const n = norm(fact);
      if (n.length < 8) continue;
      if (existing.some((e) => e === n || e.includes(n) || n.includes(e))) continue;
      await this.prisma.memory.create({ data: { content: fact, userId } });
      existing.push(n);
      saved++;
    }
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { summary: parsed.summary.trim().slice(0, 120) },
      });
    }
    if (saved) this.log.log(`learned ${saved} new fact(s) about ${userId}`);
  }

  listMemories(userId: string) {
    return this.prisma.memory.findMany({
      where: { OR: [{ userId }, { userId: null }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, content: true, userId: true, createdAt: true },
    });
  }

  addMemory(userId: string, content: string, family: boolean) {
    return this.prisma.memory.create({
      data: { content: content.trim().slice(0, 200), userId: family ? null : userId },
      select: { id: true, content: true, userId: true, createdAt: true },
    });
  }

  async deleteMemory(userId: string, role: string, id: string) {
    const m = await this.prisma.memory.findUnique({ where: { id } });
    if (!m) return { ok: true };
    if (m.userId !== userId && !(m.userId === null && role === 'ADMIN')) {
      throw new NotFoundException('Not yours to forget');
    }
    await this.prisma.memory.delete({ where: { id } });
    return { ok: true };
  }

  // messages that come with a photo go to the vision model; it either
  // answers about the image or asks for an img2img repaint
  private async handleImageMessage(
    userId: string,
    conversationId: string,
    message: string,
    imageFile: string,
    emit: (ev: StreamEvent) => void,
  ) {
    if (!(await this.visionReady())) {
      emit({
        type: 'error',
        message:
          'This server cannot see photos yet — an admin can install the Vision extension from the Models panel.',
      });
      return;
    }
    emit({ type: 'status', text: 'Looking at your image' });
    const b64 = (
      await fs.readFile(path.join(IMAGES_DIR, imageFile))
    ).toString('base64');

    let reply = '';
    let newImage: string | null = null;
    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: VISION_MODEL,
          stream: false,
          options: { num_ctx: 8192 },
          messages: [
            {
              role: 'system',
              content:
                'You are the family AI assistant. The user attached an image. Decide which of these applies and reply accordingly:\n' +
                '1. They want the WHOLE PHOTO restyled (e.g. "make this a watercolor", "cartoon this") -> reply with ONLY one line: "IMG2IMG:" followed by a detailed visual prompt describing the restyled photo.\n' +
                '2. They want the photo moved to a different setting or heavily changed while keeping the scene layout (e.g. "put this in the Harry Potter universe") -> reply with ONLY one line: "REIMAGINE:" followed by a detailed visual prompt describing the new version.\n' +
                '3. They want the PERSON in the photo placed into a brand-new scene (e.g. "make me an astronaut", "put her at Hogwarts") -> reply with ONLY one line: "FACESCENE:" followed by a detailed visual prompt of the new scene: the person (man/woman/boy/girl plus their distinctive features like hair color, facial hair, glasses — unless the user asks to change them), outfit, action, setting, lighting.\n' +
                '4. Anything else -> just answer their question about the image warmly, in Markdown.',
            },
            { role: 'user', content: message || 'What is in this image?', images: [b64] },
          ],
        }),
      });
      if (!res.ok) throw new Error(`vision model status ${res.status}`);
      const data: any = await res.json();
      reply = (data.message?.content ?? '').trim();

      const upper = reply.toUpperCase();
      const routed =
        upper.startsWith('IMG2IMG:') ? 'img2img'
        : upper.startsWith('REIMAGINE:') ? 'reimagine'
        : upper.startsWith('FACESCENE:') ? 'facescene'
        : null;
      if (routed) {
        const prompt = reply.slice(reply.indexOf(':') + 1).trim();
        const src = path.join(IMAGES_DIR, imageFile);
        if (routed === 'facescene') {
          emit({ type: 'status', text: 'Putting them in the scene (takes about a minute)' });
          // a real face swap only belongs on photographic-looking results
          const stylized =
            /cartoon|anime|ghibli|pixar|painting|watercolor|comic|illustration|drawing|sketch/i.test(
              prompt + ' ' + message,
            );
          newImage = await this.comfy.faceScene([src], prompt, {
            swap: !stylized,
            onStage: (t) => emit({ type: 'status', text: t }),
          });
        } else {
          emit({ type: 'status', text: 'Repainting your image' });
          newImage = await this.comfy.transform(src, prompt, routed === 'reimagine');
        }
        emit({ type: 'image', url: `/images/${newImage}` });
        await this.prisma.imageGeneration.create({
          data: { userId, prompt, status: 'done', filePath: newImage },
        });
        reply = 'Here you go — hope you like it!';
      }
      emit({ type: 'token', text: reply });
    } catch (e: any) {
      this.log.error(`image message failed: ${e.message}`);
      emit({ type: 'error', message: 'I had trouble with that image, sorry!' });
      return;
    }

    await this.prisma.message.create({
      data: {
        conversationId,
        role: 'assistant',
        content: reply,
        imagePath: newImage,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    emit({ type: 'done' });
  }

  // non-streaming version, handy for curl
  async send(userId: string, message: string, conversationId?: string) {
    let reply = '';
    let convoId = conversationId ?? '';
    await this.sendStream(userId, message, conversationId, undefined, (ev) => {
      if (ev.type === 'token') reply += ev.text;
      if (ev.type === 'meta') convoId = ev.conversationId;
      if (ev.type === 'error') throw new InternalServerErrorException(ev.message);
    });
    return { conversationId: convoId, reply };
  }

  private async buildSystemPrompt(userId: string, currentConversationId?: string) {
    const [user, mine, family, persona, recent] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.memory.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 60 }),
      this.prisma.memory.findMany({ where: { userId: null }, orderBy: { createdAt: 'desc' }, take: 30 }),
      this.prisma.setting.findUnique({ where: { key: 'persona' } }),
      this.prisma.conversation.findMany({
        where: { userId, summary: { not: null }, ...(currentConversationId ? { id: { not: currentConversationId } } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: { summary: true, updatedAt: true },
      }),
    ]);
    const now = await this.calendar.now();
    // a lookup table beats asking a small model to do weekday arithmetic
    const upcoming = Array.from({ length: 14 }, (_, i) => now.plus({ days: i }).toFormat('EEE MMM d')).join(', ');
    let prompt =
      BASE_PROMPT +
      `\nRight now it is ${now.toFormat('EEEE, MMMM d, yyyy h:mm a')} (${now.zoneName}). The next two weeks are: ${upcoming}. When you mention a date back to the user, always include the weekday.`;
    // admins can shape the personality from the app without touching code
    if (persona?.value?.trim()) {
      prompt += `\n\nHouse rules from the admin (follow these):\n${persona.value.trim()}`;
    }
    const name = user?.displayName ?? 'this person';
    if (user) {
      prompt += `\nYou are talking to ${name} (${user.role.toLowerCase()} account).`;
    }
    // oldest first so newer facts naturally override older ones
    if (family.length) {
      prompt += `\n\nAbout the family and about you (treat as true):\n${family.reverse().map((m) => `- ${m.content}`).join('\n')}`;
    }
    if (mine.length) {
      prompt += `\n\nWhat you know about ${name} (treat as true, use naturally, don't recite):\n${mine.reverse().map((m) => `- ${m.content}`).join('\n')}`;
    }
    if (recent.length) {
      prompt += `\n\nRecent conversations with ${name}:\n${recent
        .map((c) => `- ${c.updatedAt.toDateString()}: ${c.summary}`)
        .join('\n')}`;
    }
    return prompt;
  }

  // availability checks, cached briefly so every message doesn't re-probe
  private avail = { at: 0, tags: new Set<string>(), comfy: false };
  private async refreshAvail() {
    if (Date.now() - this.avail.at < 15_000) return;
    const tags = new Set<string>();
    let comfy = false;
    try {
      const t: any = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json());
      for (const m of t.models ?? []) tags.add(m.name.replace(/:latest$/, ''));
    } catch {}
    try {
      const comfyUrl = process.env.COMFY_URL ?? 'http://127.0.0.1:8188';
      comfy = (await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {}
    this.avail = { at: Date.now(), tags, comfy };
  }
  private async modelReady() {
    await this.refreshAvail();
    return this.avail.tags.has(await this.activeModel());
  }
  private async visionReady() {
    await this.refreshAvail();
    return this.avail.tags.has(VISION_MODEL);
  }
  private async comfyReady() {
    await this.refreshAvail();
    return this.avail.comfy;
  }

  // admins can switch the chat model from the UI; cached briefly to spare the db
  private modelCache = { value: MODEL, at: 0 };
  private async activeModel(): Promise<string> {
    if (Date.now() - this.modelCache.at > 10_000) {
      const row = await this.prisma.setting.findUnique({
        where: { key: 'chat_model' },
      });
      this.modelCache = { value: row?.value ?? MODEL, at: Date.now() };
    }
    return this.modelCache.value;
  }

  private async ollamaRound(
    messages: OllamaMsg[],
    tools: typeof TOOL_DEFS | undefined,
    onToken: (t: string) => void,
  ): Promise<{ content: string; toolCalls: any[] }> {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: await this.activeModel(),
        messages,
        stream: true,
        think: false,
        // the default 4k window silently drops history once memories and
        // tools are in the prompt; 8k fits comfortably on an 8GB card
        options: { num_ctx: 8192 },
        ...(tools ? { tools } : {}),
      }),
    });
    if (!res.ok || !res.body) throw new Error(`ollama status ${res.status}`);

    let content = '';
    const toolCalls: any[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line);
        const msg = chunk.message ?? {};
        if (msg.tool_calls?.length) toolCalls.push(...msg.tool_calls);
        if (msg.content) {
          content += msg.content;
          // don't forward text from rounds that turn out to be tool calls
          if (!toolCalls.length) onToken(msg.content);
        }
        if (chunk.done) break;
      }
    }
    return { content, toolCalls };
  }

  async listModels() {
    const res = await fetch(`${OLLAMA}/api/tags`);
    const data: any = await res.json();
    return (data.models ?? []).map((m: any) => ({
      name: m.name,
      sizeBytes: m.size,
    }));
  }
}
