import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MediaService, RequestOutcome } from './media.service';
import { LibraryImportService } from './library-import.service';

// what the jwt strategy puts on the request
interface AuthedRequest {
  user: { userId: string; username: string; role: Role };
}

class EpisodeRefDto {
  @IsInt() @Min(0) season: number;
  @IsInt() @Min(0) episode: number;
}

class RequestDto {
  @IsOptional() @IsArray() @IsInt({ each: true }) movies?: number[];
  @IsOptional() @IsInt() seriesId?: number;
  @IsOptional() @IsArray() @IsInt({ each: true }) seasons?: number[];
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EpisodeRefDto)
  episodes?: EpisodeRefDto[];
  /** "get the rest of it" — work out the gaps and ask for only those */
  @IsOptional() @IsBoolean() missingOnly?: boolean;
  /** the films of a set this one belongs to that are not here yet */
  @IsOptional() @IsBoolean() missingFilmsOfCollection?: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(
    private media: MediaService,
    private importer: LibraryImportService,
  ) {}

  @Get('health')
  health() {
    return this.media.health();
  }

  @Get('search')
  search(@Query('q') q?: string, @Query('type') type?: string) {
    const query = String(q ?? '').trim();
    if (query.length < 2)
      throw new BadRequestException('Type a title to search');
    return String(type) === 'series'
      ? this.media.searchSeries(query)
      : this.media.searchMovies(query);
  }

  @Get('series/:id/seasons')
  seasons(@Param('id', ParseIntPipe) id: number) {
    return this.media.seasons(id);
  }

  @Get('series/:id/seasons/:n/episodes')
  episodes(
    @Param('id', ParseIntPipe) id: number,
    @Param('n', ParseIntPipe) n: number,
  ) {
    return this.media.episodes(id, n);
  }

  // ---- watching something we already own ----

  @Get('watchable')
  watchable(@Query('q') q?: string) {
    const query = String(q ?? '').trim();
    if (query.length < 2)
      throw new BadRequestException('Type a title to search');
    return this.media.watchable(query);
  }

  /** What the house owns of one show, season by season. */
  @Get('series/:id/availability')
  availability(@Param('id', ParseIntPipe) id: number) {
    return this.media.seriesAvailability(id, { deep: true });
  }

  /** The other films in this one's set, marked owned or missing. */
  @Get('movies/:id/collection')
  collection(@Param('id', ParseIntPipe) id: number) {
    return this.media.collection(id);
  }

  @Get('screens')
  screens(@Query('refresh') refresh?: string) {
    return this.media.listScreens(refresh === 'true');
  }

  @Post('play')
  play(@Body() body: { itemId?: string; screen?: string }) {
    const itemId = String(body.itemId ?? '').trim();
    const screen = String(body.screen ?? '').trim();
    if (!itemId || !screen) {
      throw new BadRequestException('Pick something to watch and a TV');
    }
    return this.media
      .playOn(itemId, screen)
      .then((message) => ({ ok: true, message }));
  }

  @Post('stop')
  stop(@Body() body: { screen?: string }) {
    return this.media
      .stopScreen(String(body.screen ?? '').trim())
      .then((message) => ({ ok: true, message }));
  }

  @Get('requests')
  list(@Req() req: AuthedRequest, @Query('all') all?: string) {
    return this.media.list(req.user.userId, all !== 'false');
  }

  @Get('requests/:id')
  one(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.media.get(id, req.user.userId);
  }

  @Post('requests')
  async add(@Req() req: AuthedRequest, @Body() dto: RequestDto) {
    const userId = req.user.userId;
    const out: RequestOutcome[] = [];
    if (dto.movies?.length && dto.missingFilmsOfCollection) {
      for (const id of dto.movies) {
        out.push(...(await this.media.requestMissingFilms(userId, id)));
      }
    } else if (dto.movies?.length) {
      out.push(...(await this.media.requestMovies(userId, dto.movies)));
    }
    if (dto.seriesId && dto.missingOnly) {
      out.push(...(await this.media.requestMissing(userId, dto.seriesId)));
    } else if (dto.seriesId && dto.episodes?.length) {
      out.push(
        ...(await this.media.requestEpisodes(
          userId,
          dto.seriesId,
          dto.episodes,
        )),
      );
    } else if (dto.seriesId) {
      out.push(
        ...(await this.media.requestSeries(
          userId,
          dto.seriesId,
          dto.seasons ?? [],
        )),
      );
    }
    if (!out.length) throw new BadRequestException('Nothing was selected');
    return { results: out };
  }

  @Delete('requests/:id')
  cancel(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.media.cancel(id, req.user.userId, req.user.role);
  }

  // an admin nudge for "I just dropped a file in, pick it up now"
  @Post('scan')
  scan(@Req() req: AuthedRequest) {
    if (req.user.role !== Role.ADMIN)
      throw new ForbiddenException('Admins only');
    return this.importer.sweep();
  }
}
