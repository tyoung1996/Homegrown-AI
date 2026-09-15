import {
  BadRequestException,
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

// server-sent events that survive proxies (cloudflare, tunnels, nginx):
// no-transform stops compression, x-accel-buffering stops nginx-style
// buffering, a 4kb comment up front pushes the stream past the buffer
// threshold so the first real event isn't held back, and a heartbeat
// comment every 10s keeps idle-timeouts away while a model loads or an
// image renders (comments are ignored by the client)
export function startEventStream(res: Response) {
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();
  res.write(`: ${' '.repeat(4096)}\n\n`);
  const beat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 10_000);
  const stop = () => clearInterval(beat);
  res.on('close', stop);
  res.on('finish', stop);
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
    startEventStream(res);
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

  // what the assistant knows about you — see it, teach it, make it forget
  @Get('memories')
  memories(@Req() req: any) {
    return this.chat.listMemories(req.user.userId);
  }

  @Post('memories')
  addMemory(@Req() req: any, @Body() body: { content?: string; family?: boolean }) {
    const content = String(body.content ?? '').trim();
    if (!content) throw new BadRequestException('Write something to remember');
    const family = !!body.family && req.user.role === 'ADMIN';
    return this.chat.addMemory(req.user.userId, content, family);
  }

  @Delete('memories/:id')
  forget(@Req() req: any, @Param('id') id: string) {
    return this.chat.deleteMemory(req.user.userId, req.user.role, id);
  }
}
