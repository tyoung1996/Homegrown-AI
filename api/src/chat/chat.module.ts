import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ImagesController } from './images.controller';
import { ModelsController } from './models.controller';
import { StudioController } from './studio.controller';
import { ChatService } from './chat.service';
import { ToolsService } from './tools.service';
import { ComfyService } from './comfy.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [ChatController, ImagesController, ModelsController, StudioController],
  providers: [ChatService, ToolsService, ComfyService, PrismaService],
})
export class ChatModule {}
