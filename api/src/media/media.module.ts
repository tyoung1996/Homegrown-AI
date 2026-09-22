import { Module } from '@nestjs/common';
import { PostersController } from './posters.controller';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { CatalogService } from './catalog.service';
import { JellyfinService } from './jellyfin.service';
import { ScreensService } from './screens.service';
import { LibraryImportService } from './library-import.service';
import { AcquisitionRegistry, DropFolderSource } from './acquisition';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [MediaController, PostersController],
  providers: [
    MediaService,
    CatalogService,
    JellyfinService,
    ScreensService,
    LibraryImportService,
    AcquisitionRegistry,
    DropFolderSource,
    PrismaService,
  ],
  // the chat tools need the same service the http api uses
  exports: [MediaService, CatalogService, JellyfinService, ScreensService],
})
export class MediaModule {}
