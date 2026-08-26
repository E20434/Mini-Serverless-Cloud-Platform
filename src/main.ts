import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // whitelist: true strips any request body property not declared on the
  // DTO; forbidNonWhitelisted would instead reject the whole request -
  // we're choosing the more forgiving option for now. transform: true is
  // what makes memoryMb/timeoutMs arrive as actual numbers instead of
  // strings straight off the wire.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  console.log(`Function API listening on http://localhost:${port}`);
}

bootstrap();
