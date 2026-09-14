import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true });
  app.use(json({ limit: '30mb' })); // photo uploads come in as base64

  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  await app.listen(3001, '0.0.0.0');
}
bootstrap();
