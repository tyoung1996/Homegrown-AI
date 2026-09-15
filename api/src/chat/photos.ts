import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { IMAGES_DIR } from './comfy.service';

// every uploaded photo goes through here: phones send 12-megapixel jpegs
// with exif rotation, which the vision model rejects and the image model
// can't fit in memory. we auto-rotate, shrink to a sane size, and store a
// clean jpeg. returns the stored filename.
export async function savePhoto(dataUrl: string, maxEdge = 1536): Promise<string> {
  const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) throw new BadRequestException('That doesn\'t look like a photo');
  const input = Buffer.from(m[1], 'base64');
  if (input.length > 40 * 1024 * 1024) throw new BadRequestException('That photo is too large (40 MB max)');
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  const name = `${randomUUID()}.jpg`;
  try {
    await sharp(input, { failOn: 'none' })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(path.join(IMAGES_DIR, name));
  } catch {
    throw new BadRequestException('That photo format isn\'t supported — try a JPG or PNG');
  }
  return name;
}
