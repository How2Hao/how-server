import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserModule } from './user/user.module';
import { ZodValidationPipe } from 'nestjs-zod';
import { APP_PIPE } from '@nestjs/core';
import { CrawlerModule } from './crawler/crawler.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from 'nestjs-prisma';
@Module({
  imports: [
    UserModule,
    CrawlerModule,
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
  ],
})
export class AppModule {}
