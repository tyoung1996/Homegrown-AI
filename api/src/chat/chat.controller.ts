import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';

class SendDto {
  @IsString() @IsNotEmpty() @MaxLength(8000) message: string;
  @IsOptional() @IsString() conversationId?: string;
  @IsOptional() @IsString() imageData?: string; // data-url of an attached photo
}

@UseGuards(JwtAuthGuard)
@Controller()
export class ChatController {
  constructor(private chat: ChatService) {}

  @Get('conversations')
  conversations(@Req() req: any) {
    return this.chat.listConversations(req.user.userId);
  }

  @Get('conversations/:id/messages')
  messages(@Req() req: any, @Param('id') id: string) {
    return this.chat.getMessages(req.user.userId, id);
  }

  @Delete('conversations/:id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.chat.deleteConversation(req.user.userId, id);
  }

  @Post('chat')
  send(@Req() req: any, @Body() dto: SendDto) {
    return this.chat.send(req.user.userId, dto.message, dto.conversationId);
  }

  @Post('chat/stream')
  async stream(@Req() req: any, @Body() dto: SendDto, @Res() res: Response) {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();
    const emit = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    try {
      await this.chat.sendStream(
        req.user.userId,
        dto.message,
        dto.conversationId,
        dto.imageData,
        emit,
      );
    } catch (e: any) {
      emit({ type: 'error', message: e.message ?? 'Something went wrong' });
    }
    res.end();
  }

  @Get('models')
  models() {
    return this.chat.listModels();
  }
}
