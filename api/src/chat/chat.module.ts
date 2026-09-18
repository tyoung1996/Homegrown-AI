import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ImagesController } from './images.controller';
import { ModelsController } from './models.controller';
import { StudioController } from './studio.controller';
import {
  CalendarController,
  CalendarFeedController,
} from './calendar.controller';
import { CalendarService } from './calendar.service';
import { ChatService } from './chat.service';
import { ToolsService } from './tools.service';
import { ComfyService } from './comfy.service';
import { PrismaService } from '../prisma.service';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [MediaModule],
  controllers: [
    ChatController,
    ImagesController,
    ModelsController,
    StudioController,
    CalendarController,
    CalendarFeedController,
  ],
  providers: [
    ChatService,
    ToolsService,
    ComfyService,
    CalendarService,
    PrismaService,
  ],
})
export class ChatModule {}
