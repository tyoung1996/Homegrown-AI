import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'stream';
import { JellyfinService } from './jellyfin.service';
import { streamToken } from './stream-token';

/**
 * The film, on its way to a TV.
 *
 * Jellyfin will not take its key in a query string any more, and a TV cannot
 * send a header, so the two cannot talk directly. The app stands between
 * them: it asks Jellyfin properly and passes the bytes along.
 *
 * There is no bearer token here because nothing that plays a url can send
 * one. Instead each link carries a signature only this server could have
 * produced, so a link works and guessing one does not. The Jellyfin key
 * itself never leaves the server.
 */
@Controller('media')
export class StreamController {
  constructor(private jellyfin: JellyfinService) {}

  @Get('stream/:id')
  async stream(
    @Param('id') id: string,
    @Query('t') token: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    if (!/^[a-f0-9-]{8,64}$/i.test(id)) throw new NotFoundException();
    if (!token || token !== streamToken(id)) throw new NotFoundException();

    const upstream = await this.jellyfin.stream(id, range);
    if (!upstream?.body) throw new NotFoundException();

    res.status(upstream.status);
    for (const [k, v] of Object.entries(upstream.headers)) res.setHeader(k, v);
    Readable.fromWeb(
      upstream.body as Parameters<typeof Readable.fromWeb>[0],
    ).pipe(res);
  }
}
