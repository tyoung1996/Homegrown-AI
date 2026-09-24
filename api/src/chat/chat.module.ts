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
import {
  VERIFIED_ACTIONS,
  VerifiedAction,
  VerifiedActions,
} from './actions/verified-action';
import { StopAction } from './actions/stop.action';

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
    StopAction,
    // physical actions checked and described without the model. only stop
    // for now; pause and resume would be registered here the same way
    {
      provide: VERIFIED_ACTIONS,
      useFactory: (stop: StopAction): VerifiedAction[] => [stop],
      inject: [StopAction],
    },
    VerifiedActions,
  ],
})
export class ChatModule {}
