import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { CatalogService } from './catalog.service';
import { JellyfinService } from './jellyfin.service';
import { LibraryImportService } from './library-import.service';
import { AcquisitionRegistry, DropFolderSource } from './acquisition';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [MediaController],
  providers: [
    MediaService,
    CatalogService,
    JellyfinService,
    LibraryImportService,
    AcquisitionRegistry,
    DropFolderSource,
    PrismaService,
  ],
  // the chat tools need the same service the http api uses
  exports: [MediaService, CatalogService, JellyfinService],
})
export class MediaModule {}
