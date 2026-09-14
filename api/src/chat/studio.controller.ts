import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma.service';
import { ComfyService, IMAGES_DIR, Quality } from './comfy.service';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const VISION_MODEL = process.env.VISION_MODEL ?? 'qwen2.5vl:7b';
const MAX_PHOTOS = 5;

// swap = finish with a real face swap; only right for styles where a
// photographic face belongs (it looks pasted-on in cartoon styles)
const STYLES: Record<string, { prompt: string; swap: boolean }> = {
  photo: { prompt: 'candid photo, dslr, natural lighting, sharp focus, high detail', swap: true },
  fantasy: { prompt: 'epic fantasy art, cinematic, dramatic lighting, richly detailed', swap: true },
  ghibli: { prompt: 'studio ghibli anime style, hand-painted, soft warm colors, whimsical', swap: false },
  pixar: { prompt: '3d animated movie style, pixar look, expressive, colorful, soft lighting', swap: false },
  watercolor: { prompt: 'delicate watercolor painting, soft washes of color, textured paper', swap: false },
  comic: { prompt: 'bold comic book illustration, ink outlines, halftone shading, dynamic', swap: false },
};

function saveDataUrl(dataUrl: string): Promise<string> {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new BadRequestException('Not a usable image');
  const name = `${randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  return fs
    .mkdir(IMAGES_DIR, { recursive: true })
    .then(() => fs.writeFile(path.join(IMAGES_DIR, name), Buffer.from(m[2], 'base64')))
    .then(() => name);
}

@UseGuards(JwtAuthGuard)
@Controller('studio')
export class StudioController {
  private log = new Logger('Studio');

  constructor(
    private prisma: PrismaService,
    private comfy: ComfyService,
  ) {}

  @Get('people')
  async people() {
    const rows = await this.prisma.person.findMany({
      orderBy: { createdAt: 'asc' },
      include: { photos: { select: { id: true, imagePath: true } } },
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      imagePath: p.imagePath,
      createdBy: p.createdBy,
      photos: p.photos,
    }));
  }

  @Post('people')
  async addPerson(@Req() req: any, @Body() body: any) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequestException('Give them a name');
    const imagePath = await saveDataUrl(String(body.imageData ?? ''));
    const description = await this.describe(imagePath);
    const p = await this.prisma.person.create({
      data: {
        name,
        imagePath,
        description,
        createdBy: req.user.userId,
        photos: { create: { imagePath } },
      },
      include: { photos: { select: { id: true, imagePath: true } } },
    });
    return { id: p.id, name: p.name, description: p.description, imagePath: p.imagePath, createdBy: p.createdBy, photos: p.photos };
  }

  @Post('people/:id/photos')
  async addPhoto(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const person = await this.prisma.person.findUnique({ where: { id }, include: { photos: true } });
    if (!person) throw new BadRequestException('Unknown person');
    if (person.createdBy !== req.user.userId && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only whoever added them (or an admin) can change their photos');
    }
    if (person.photos.length >= MAX_PHOTOS) {
      throw new BadRequestException(`${MAX_PHOTOS} photos is plenty — remove one first`);
    }
    const imagePath = await saveDataUrl(String(body.imageData ?? ''));
    return this.prisma.personPhoto.create({
      data: { personId: id, imagePath },
      select: { id: true, imagePath: true },
    });
  }

  @Delete('photos/:photoId')
  async removePhoto(@Req() req: any, @Param('photoId') photoId: string) {
    const photo = await this.prisma.personPhoto.findUnique({
      where: { id: photoId },
      include: { person: { include: { photos: true } } },
    });
    if (!photo) return { ok: true };
    if (photo.person.createdBy !== req.user.userId && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only whoever added them (or an admin) can change their photos');
    }
    if (photo.person.photos.length <= 1) {
      throw new BadRequestException('A person needs at least one photo');
    }
    await this.prisma.personPhoto.delete({ where: { id: photoId } });
    if (photo.person.imagePath === photo.imagePath) {
      const next = photo.person.photos.find((p) => p.id !== photoId);
      if (next) {
        await this.prisma.person.update({ where: { id: photo.personId }, data: { imagePath: next.imagePath } });
      }
    }
    return { ok: true };
  }

  @Delete('people/:id')
  async removePerson(@Req() req: any, @Param('id') id: string) {
    const p = await this.prisma.person.findUnique({ where: { id } });
    if (!p) return { ok: true };
    if (p.createdBy !== req.user.userId && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the person who added them (or an admin) can remove them');
    }
    await this.prisma.person.delete({ where: { id } });
    return { ok: true };
  }

  // streams progress stages, then the finished image
  @Post('generate/stream')
  async generateStream(@Req() req: any, @Body() body: any, @Res() res: Response) {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.flushHeaders?.();
    const emit = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    try {
      const url = await this.generateImage(req.user.userId, body, (text) => emit({ type: 'stage', text }));
      emit({ type: 'image', url });
      emit({ type: 'done' });
    } catch (e: any) {
      this.log.error(`studio generate failed: ${e.message}`);
      emit({ type: 'error', message: e.message ?? 'Something went wrong' });
    }
    res.end();
  }

  // plain version, handy for scripts
  @Post('generate')
  async generate(@Req() req: any, @Body() body: any) {
    const url = await this.generateImage(req.user.userId, body, () => {});
    return { url };
  }

  private async generateImage(userId: string, body: any, stage: (t: string) => void): Promise<string> {
    const idea = String(body.prompt ?? '').trim();
    if (!idea) throw new BadRequestException('Describe the image you want');
    const style = STYLES[String(body.style ?? 'photo')] ?? STYLES.photo;
    const quality: Quality = body.quality === 'best' ? 'best' : 'fast';

    let person: { id: string; name: string; description: string | null; imagePath: string; photos: { imagePath: string }[] } | null = null;
    if (body.personId) {
      person = await this.prisma.person.findUnique({
        where: { id: String(body.personId) },
        include: { photos: { select: { imagePath: true } } },
      });
      if (!person) throw new BadRequestException('Unknown person');
    }

    stage('Writing the prompt');
    const expanded = await this.expandPrompt(idea, person?.description ?? null, style.prompt);
    const fullPrompt = `${expanded}, ${style.prompt}`;

    let file: string;
    if (person) {
      const refs = [person.imagePath, ...person.photos.map((p) => p.imagePath)]
        .filter((v, i, a) => a.indexOf(v) === i)
        .map((f) => path.join(IMAGES_DIR, f));
      file = await this.comfy.faceScene(refs, fullPrompt, {
        swap: style.swap,
        quality,
        personName: person.name,
        onStage: (t) => stage(t === 'Matching the face' ? `Matching ${person!.name}` : t),
      });
    } else {
      file = await this.comfy.generate(fullPrompt, quality, stage);
    }

    await this.prisma.imageGeneration.create({
      data: { userId, prompt: fullPrompt, status: 'done', filePath: file },
    });
    return `/images/${file}`;
  }

  // the chat model turns a one-line idea into a real photographic prompt —
  // composition, pose, lighting — before anything renders
  private async expandPrompt(idea: string, personDescription: string | null, styleHint: string): Promise<string> {
    const model = (await this.prisma.setting.findUnique({ where: { key: 'chat_model' } }))?.value
      ?? process.env.CHAT_MODEL ?? 'qwen3:8b';
    const who = personDescription
      ? `The main subject is a real person; describe them ONLY as "${personDescription}" — never invent a different look and never use a name.`
      : 'There is no specific real person; invent whatever subject fits.';
    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          options: { num_predict: 180, temperature: 0.7 },
          messages: [
            {
              role: 'system',
              content:
                'You write prompts for an image model. Turn the idea into ONE vivid, concrete prompt of 50-80 words: the subject and their exact pose and action, how they relate to the scene (e.g. seated astride the dragon\'s neck gripping reins), the setting, lighting, and camera framing (wide shot / medium / close-up). ' +
                who +
                ` Match this style: ${styleHint}. Output only the prompt — no quotes, no lists, no preamble.`,
            },
            { role: 'user', content: idea },
          ],
        }),
      });
      const data: any = await res.json();
      const text = String(data.message?.content ?? '').replace(/\s+/g, ' ').trim();
      if (text.length > 20) {
        this.log.log(`prompt: ${text.slice(0, 120)}…`);
        return text;
      }
    } catch (e: any) {
      this.log.warn(`prompt expansion skipped: ${e.message}`);
    }
    return personDescription ? `${personDescription} ${idea}` : idea;
  }

  // one-line description of how a person looks, written once when they're added
  private async describe(imagePath: string): Promise<string> {
    try {
      const b64 = (await fs.readFile(path.join(IMAGES_DIR, imagePath))).toString('base64');
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: VISION_MODEL,
          stream: false,
          options: { num_predict: 60 },
          messages: [
            {
              role: 'system',
              content:
                'Describe the person in the photo as a short noun phrase for an image prompt: apparent gender and rough age, hair color and length, facial hair, glasses, anything distinctive. Example: "a man in his 30s with short brown hair, a full red beard and round glasses". Output only the phrase.',
            },
            { role: 'user', content: 'Describe this person.', images: [b64] },
          ],
        }),
      });
      const data: any = await res.json();
      const text = String(data.message?.content ?? '').replace(/\s+/g, ' ').replace(/^["']|["'.]+$/g, '').trim();
      if (text.length > 5) return text.slice(0, 160);
    } catch (e: any) {
      this.log.warn(`could not describe person: ${e.message}`);
    }
    return 'a person';
  }

  @Get('gallery')
  async gallery(@Req() req: any) {
    const rows = await this.prisma.imageGeneration.findMany({
      where: { userId: req.user.userId, status: 'done', filePath: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { id: true, prompt: true, filePath: true, createdAt: true },
    });
    return rows.map((r) => ({ ...r, url: `/images/${r.filePath}` }));
  }

  @Get('capabilities')
  async capabilities() {
    const [instantId, faceSwap, detailer] = await Promise.all([
      this.comfy.hasNode('ApplyInstantID'),
      this.comfy.hasNode('ReActorFaceSwap'),
      this.comfy.hasNode('FaceDetailer'),
    ]);
    return { strongLikeness: instantId, faceSwap, faceDetailer: detailer };
  }
}
