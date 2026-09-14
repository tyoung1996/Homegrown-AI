import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma.service';
import { ToolsService, TOOL_DEFS } from './tools.service';
import { ComfyService, IMAGES_DIR } from './comfy.service';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.CHAT_MODEL ?? 'qwen3:8b';
const VISION_MODEL = process.env.VISION_MODEL ?? 'qwen2.5vl:7b';
const MAX_TOOL_ROUNDS = 3;

export type StreamEvent =
  | { type: 'meta'; conversationId: string }
  | { type: 'status'; text: string }
  | { type: 'token'; text: string }
  | { type: 'image'; url: string }
  | { type: 'sources'; urls: string[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

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
  'You have tools: generate_image to create pictures when someone asks you to draw, paint, or make an image; ' +
  'remember to permanently save lasting facts people tell you (names, birthdays, preferences — always save these); ' +
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

    // an attached photo gets written to disk and linked to the message
    let uploadedImage: string | null = null;
    if (imageData) {
      const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(imageData);
      if (m) {
        await fs.mkdir(IMAGES_DIR, { recursive: true });
        uploadedImage = `${randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
        await fs.writeFile(
          path.join(IMAGES_DIR, uploadedImage),
          Buffer.from(m[2], 'base64'),
        );
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
      { role: 'system', content: await this.buildSystemPrompt(userId) },
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
    const tools = (await this.comfyReady())
      ? TOOL_DEFS
      : TOOL_DEFS.filter((t) => t.function.name !== 'generate_image');

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
          if (name === 'generate_image') {
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
      },
    });
    await this.prisma.conversation.update({
      where: { id: convo.id },
      data: { updatedAt: new Date() },
    });
    if (sources.size) emit({ type: 'sources', urls: [...sources].slice(0, 8) });
    emit({ type: 'done' });
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

  private async buildSystemPrompt(userId: string) {
    const [user, memories, persona] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.memory.findMany({
        where: { OR: [{ userId }, { userId: null }] },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      this.prisma.setting.findUnique({ where: { key: 'persona' } }),
    ]);
    let prompt = BASE_PROMPT + `\nToday's date is ${new Date().toDateString()}.`;
    // admins can shape the personality from the app without touching code
    if (persona?.value?.trim()) {
      prompt += `\n\nHouse rules from the admin (follow these):\n${persona.value.trim()}`;
    }
    if (user) {
      prompt += `\nYou are talking to ${user.displayName} (${user.role.toLowerCase()} account).`;
    }
    if (memories.length) {
      // oldest first so newer facts naturally override older ones
      const lines = memories
        .reverse()
        .map((m) => `- ${m.content}`)
        .join('\n');
      prompt += `\n\nYour memories (facts you saved in earlier chats — treat them as true):\n${lines}`;
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
