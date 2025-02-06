import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CrawlerService } from './crawler.service';
import { CrawlerController } from './crawler.controller';
import { CrawlerLogic } from './crawler.logic';

@Module({
  imports: [
    ScheduleModule.forRoot(), // 启用定时任务模块
  ],
  controllers: [CrawlerController],
  providers: [CrawlerService, CrawlerLogic],
})
export class CrawlerModule {}
