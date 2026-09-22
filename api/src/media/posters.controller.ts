import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { JellyfinService } from './jellyfin.service';

/**
 * Cover art, passed through from Jellyfin.
 *
 * The browser cannot reach Jellyfin directly — it answers on the server's own
 * loopback address — and it must never be handed the API key, so the pictures
 * come through here instead. Served without auth for the same reason the
 * generated images are: a plain <img> tag cannot send a token, and the only
 * thing on offer is the poster of a film the family already owns.
 */
@Controller('media')
export class PostersController {
  constructor(private jellyfin: JellyfinService) {}

  @Get('poster/:id')
  async poster(@Param('id') id: string, @Res() res: Response) {
    if (!/^[a-f0-9-]{8,64}$/i.test(id)) throw new NotFoundException();
    const image = await this.jellyfin.image(id);
    if (!image) throw new NotFoundException();
    res.setHeader('content-type', image.contentType);
    // posters never change; let the browser keep them for a day
    res.setHeader('cache-control', 'public, max-age=86400');
    res.send(image.body);
  }
}
