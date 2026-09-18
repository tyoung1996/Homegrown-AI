import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { MediaModule } from './media/media.module';

@Module({
  imports: [AuthModule, ChatModule, MediaModule],
})
export class AppModule {}
