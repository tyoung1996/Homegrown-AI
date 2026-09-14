import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import * as path from 'path';
import { existsSync } from 'fs';
import { IMAGES_DIR } from './comfy.service';

// served without auth so plain <img> tags work; filenames are random uuids
@Controller('images')
export class ImagesController {
  @Get(':name')
  get(@Param('name') name: string, @Res() res: Response) {
    if (!/^[a-f0-9-]+\.(png|jpg|jpeg|webp)$/i.test(name)) {
      throw new NotFoundException();
    }
    const file = path.join(IMAGES_DIR, name);
    if (!existsSync(file)) throw new NotFoundException();
    res.sendFile(file);
  }
}
