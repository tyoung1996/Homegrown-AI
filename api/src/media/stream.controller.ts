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
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import { JellyfinService } from './jellyfin.service';
import { MEDIA_ROOT } from './paths';
import { streamToken } from './stream-token';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ts': 'video/mp2t',
};

/**
 * The film, on its way to a TV.
 *
 * The library is a folder on this server, so the bytes are sent straight
 * from the disk. That is one fewer service in the path than asking Jellyfin
 * to serve its own file, and it does not care which of its urls Jellyfin
 * currently answers — only Jellyfin's catalogue is consulted, to turn an
 * item id into a path.
 *
 * There is no bearer token here because nothing that plays a url can send
 * one. Each link carries a signature only this server could have produced,
 * so a link works and a guess does not.
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

    const file = await this.jellyfin.filePath(id);
    if (!file) throw new NotFoundException();

    // only ever out of the library folder, whatever the catalogue says
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(MEDIA_ROOT) + path.sep)) {
      throw new NotFoundException();
    }
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile()) throw new NotFoundException();

    const type = TYPES[path.extname(resolved).toLowerCase()] ?? 'video/mp4';
    res.setHeader('content-type', type);
    res.setHeader('accept-ranges', 'bytes');

    // a TV asking for the middle of a film is how seeking works
    const asked = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
    if (asked) {
      const start = asked[1] ? Number(asked[1]) : 0;
      const end = asked[2] ? Number(asked[2]) : stat.size - 1;
      if (start >= stat.size || end < start) {
        res.setHeader('content-range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      const last = Math.min(end, stat.size - 1);
      res.status(206);
      res.setHeader('content-range', `bytes ${start}-${last}/${stat.size}`);
      res.setHeader('content-length', String(last - start + 1));
      return createReadStream(resolved, { start, end: last }).pipe(res);
    }

    res.status(200);
    res.setHeader('content-length', String(stat.size));
    return createReadStream(resolved).pipe(res);
  }
}
