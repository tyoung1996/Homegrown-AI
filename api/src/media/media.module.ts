import { Module } from '@nestjs/common';
import { PostersController } from './posters.controller';
import { StreamController } from './stream.controller';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { CatalogService } from './catalog.service';
import { AvailabilityService } from './availability.service';
import { JellyfinService } from './jellyfin.service';
import { ScreensService } from './screens.service';
import { LibraryImportService } from './library-import.service';
import { InternetArchiveSource } from './internet-archive.source';
import {
  ACQUISITION_SOURCES,
  AcquisitionRegistry,
  AcquisitionSource,
  DropFolderSource,
} from './acquisition';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [MediaController, PostersController, StreamController],
  providers: [
    MediaService,
    CatalogService,
    JellyfinService,
    AvailabilityService,
    ScreensService,
    LibraryImportService,
    DropFolderSource,
    InternetArchiveSource,
    // the one place that knows which providers exist. a new provider is
    // added here and nowhere else; ACQUISITION_ORDER decides who goes first
    {
      provide: ACQUISITION_SOURCES,
      useFactory: (
        dropFolder: DropFolderSource,
        archive: InternetArchiveSource,
      ): AcquisitionSource[] => [archive, dropFolder],
      inject: [DropFolderSource, InternetArchiveSource],
    },
    AcquisitionRegistry,
    PrismaService,
  ],
  // the chat tools need the same service the http api uses
  exports: [
    MediaService,
    CatalogService,
    JellyfinService,
    AvailabilityService,
    ScreensService,
  ],
})
export class MediaModule {}
