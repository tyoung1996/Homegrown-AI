import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import * as path from 'path';
import { existsSync } from 'fs';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { IMAGES_DIR } from './comfy.service';
import { CARD_SIZES } from './studio.controller';

const DPI = 300;
const PT = 72; // pdf points per inch

// served without auth so plain <img> tags and download links work;
// filenames are random uuids
@Controller()
export class ImagesController {
  @Get('images/:name')
  get(@Param('name') name: string, @Res() res: Response) {
    const file = this.resolve(name);
    res.sendFile(file);
  }

  // print-ready pdf: the picture upscaled to 300 dpi at its real size,
  // one per page or two on a letter sheet with cut marks
  @Get('print/:name')
  async print(
    @Param('name') name: string,
    @Query('size') sizeKey = 'square',
    @Query('per') per = '1',
    @Res() res: Response,
  ) {
    const file = this.resolve(name);
    const card = CARD_SIZES[sizeKey] ?? CARD_SIZES.square;
    const [wIn, hIn] = card.inches;
    const png = await sharp(file)
      .resize(wIn * DPI, hIn * DPI, { fit: 'cover', kernel: 'lanczos3' })
      .sharpen({ sigma: 0.6 })
      .png()
      .toBuffer();

    const pdf = await PDFDocument.create();
    pdf.setTitle('Circuit Barn card');
    const img = await pdf.embedPng(png);
    const cw = wIn * PT;
    const ch = hIn * PT;

    if (per === '2') {
      // letter, landscape, two cards side by side, cut marks at the corners
      const page = pdf.addPage([11 * PT, 8.5 * PT]);
      const gap = 0.25 * PT;
      const x0 = (11 * PT - (cw * 2 + gap)) / 2;
      const y0 = (8.5 * PT - ch) / 2;
      for (const x of [x0, x0 + cw + gap]) {
        page.drawImage(img, { x, y: y0, width: cw, height: ch });
        const m = 0.15 * PT;
        for (const [cx, cy] of [[x, y0], [x + cw, y0], [x, y0 + ch], [x + cw, y0 + ch]] as [number, number][]) {
          page.drawLine({ start: { x: cx - m, y: cy }, end: { x: cx + m, y: cy }, thickness: 0.5 });
          page.drawLine({ start: { x: cx, y: cy - m }, end: { x: cx, y: cy + m }, thickness: 0.5 });
        }
      }
    } else {
      const page = pdf.addPage([cw, ch]);
      page.drawImage(img, { x: 0, y: 0, width: cw, height: ch });
    }

    const bytes = await pdf.save();
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="circuit-barn-${sizeKey}${per === '2' ? '-2up' : ''}.pdf"`);
    res.send(Buffer.from(bytes));
  }

  private resolve(name: string) {
    if (!/^[a-f0-9-]+\.(png|jpg|jpeg|webp)$/i.test(name)) throw new NotFoundException();
    const file = path.join(IMAGES_DIR, name);
    if (!existsSync(file)) throw new NotFoundException();
    return file;
  }
}
