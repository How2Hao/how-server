import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CrawlerLogic } from './crawler.logic';

@Injectable()
export class CrawlerService {
  constructor(private readonly crawlerLogic: CrawlerLogic) {}
  // @Cron(CronExpression.EVERY_MINUTE) // 每分钟执行一次
  async handleCron() {
    await this.crawlerLogic.run();
  }
}
