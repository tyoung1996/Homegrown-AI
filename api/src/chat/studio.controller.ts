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
import sharp from 'sharp';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma.service';
import { ComfyService, IMAGES_DIR, Quality } from './comfy.service';
import { startEventStream } from './chat.controller';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const VISION_MODEL = process.env.VISION_MODEL ?? 'qwen2.5vl:7b';
const MAX_PHOTOS = 5;

// print sizes: what the model renders (multiples of 64, close to the real
// ratio) and the true 300-dpi pixel size the print endpoint upscales to
export const CARD_SIZES: Record<string, { render: { width: number; height: number }; inches: [number, number] }> = {
  square: { render: { width: 1024, height: 1024 }, inches: [5, 5] },
  '4x6': { render: { width: 832, height: 1248 }, inches: [4, 6] },
  '5x7': { render: { width: 896, height: 1280 }, inches: [5, 7] },
};

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
    startEventStream(res);
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

    // words: a multi-line block (first line is the title); legacy title/details still work
    const lines = String(body.words ?? [body.title, body.details].filter(Boolean).join('\n'))
      .split('\n')
      .map((l) => l.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 8);
    const wantsText = lines.length > 0;
    const sizeKey = CARD_SIZES[String(body.size ?? 'square')] ? String(body.size) : 'square';
    const card = CARD_SIZES[sizeKey];

    stage('Writing the prompt');
    const expanded = await this.expandPrompt(
      idea,
      person?.description ?? null,
      style.prompt,
      wantsText,
      card.render.height > card.render.width,
    );
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
        size: card.render,
        onStage: (t) => stage(t === 'Matching the face' ? `Matching ${person!.name}` : t),
      });
    } else {
      file = await this.comfy.generate(fullPrompt, quality, stage, card.render);
    }

    if (wantsText) {
      stage('Adding the words');
      file = await this.writeWordsOn(file, lines, sizeKey !== 'square' || lines.length > 2);
    }

    await this.prisma.imageGeneration.create({
      data: { userId, prompt: fullPrompt, status: 'done', filePath: file },
    });
    return `/images/${file}`;
  }

  // image models can't spell, so the server prints the words. two looks:
  // a soft dark band for a title and a line (social graphics), or a cream
  // card panel for real invitations and rsvp cards with several lines,
  // blanks (____) and checkboxes (☐)
  private async writeWordsOn(file: string, lines: string[], panel: boolean): Promise<string> {
    const src = path.join(IMAGES_DIR, file);
    const image = sharp(src);
    const { width = 1024, height = 1024 } = await image.metadata();
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const FONT = 'Fredoka, Bangers, DejaVu Sans, sans-serif';
    const [title, ...rest] = lines;
    const longest = Math.max(1, ...rest.map((l) => l.length));
    let svg: string;

    if (!panel) {
      const details = rest.join('  ·  ');
      const bandH = Math.round(height * (details ? 0.24 : 0.17));
      const titleSize = Math.round(Math.min(width / Math.max(6, title.length * 0.62), height * 0.11));
      const detailSize = Math.round(Math.min(width / Math.max(12, details.length * 0.55), height * 0.045));
      svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.35" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0.75"/>
  </linearGradient></defs>
  <rect x="0" y="${height - bandH}" width="${width}" height="${bandH}" fill="url(#g)"/>
  <text x="${width / 2}" y="${height - bandH + bandH * (details ? 0.5 : 0.62)}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${titleSize}" fill="#fff" stroke="#000" stroke-width="${Math.max(2, titleSize / 18)}" paint-order="stroke">${esc(title)}</text>
  ${details ? `<text x="${width / 2}" y="${height - bandH * 0.18}" text-anchor="middle" font-family="${FONT}" font-weight="600" font-size="${detailSize}" fill="#fff" stroke="#000" stroke-width="${Math.max(1, detailSize / 20)}" paint-order="stroke">${esc(details)}</text>` : ''}
</svg>`;
    } else {
      const margin = Math.round(width * 0.05);
      const pad = Math.round(width * 0.045);
      const titleSize = Math.round(Math.min(width * 0.085, (width * 0.9) / Math.max(6, title.length * 0.58)));
      const lineSize = Math.round(Math.min(width * 0.042, (width * 0.86) / Math.max(10, longest * 0.5)));
      const lineH = Math.round(lineSize * 1.55);
      const panelH = pad * 2 + Math.round(titleSize * 1.25) + rest.length * lineH;
      const top = height - margin - panelH;
      const textLines = rest
        .map((l, i) =>
          `<text x="${width / 2}" y="${top + pad + Math.round(titleSize * 1.25) + (i + 1) * lineH - Math.round(lineH * 0.3)}" text-anchor="middle" font-family="${FONT}" font-weight="500" font-size="${lineSize}" fill="#2a2622">${esc(l)}</text>`,
        )
        .join('\n');
      svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${margin}" y="${top}" width="${width - margin * 2}" height="${panelH}" rx="${Math.round(width * 0.025)}" fill="#fbf6ec" fill-opacity="0.96" stroke="#b3402f" stroke-opacity="0.35" stroke-width="3"/>
  <text x="${width / 2}" y="${top + pad + Math.round(titleSize * 0.95)}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${titleSize}" fill="#b3402f">${esc(title)}</text>
  ${textLines}
</svg>`;
    }

    const out = `${randomUUID()}.png`;
    await image
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toFile(path.join(IMAGES_DIR, out));
    return out;
  }

  // the chat model turns a one-line idea into a real photographic prompt —
  // composition, pose, lighting — before anything renders
  private async expandPrompt(
    idea: string,
    personDescription: string | null,
    styleHint: string,
    leaveRoomForText = false,
    portrait = false,
  ): Promise<string> {
    const model = (await this.prisma.setting.findUnique({ where: { key: 'chat_model' } }))?.value
      ?? process.env.CHAT_MODEL ?? 'qwen3:8b';
    const who = personDescription
      ? `The main subject is a real person; describe them ONLY as "${personDescription}" — never invent a different look and never use a name.`
      : 'There is no specific real person; invent whatever subject fits. If the idea names a well-known character, describe that character\'s look concretely (colors, shape, outfit) so it is recognizable.';
    const textRule =
      (leaveRoomForText
        ? ' This picture will have words printed on it afterwards: keep the bottom third of the frame simple and uncluttered, and never draw letters, words, signs, or banners.'
        : ' Never draw letters or words.') +
      (portrait ? ' The frame is a tall portrait card; compose for that.' : '');
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
                textRule +
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
