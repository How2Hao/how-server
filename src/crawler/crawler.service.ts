import { Injectable } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CrawlerLogic } from './crawler.logic';

@Injectable()
export class CrawlerService {
  private isRunning: boolean = true;

  constructor(
    private readonly crawlerLogic: CrawlerLogic,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'crawler',
  }) // 每分钟执行一次
  async handleCron() {
    await this.crawlerLogic.run();
  }

  startCron() {
    const job = this.schedulerRegistry.getCronJob('crawler');
    this.isRunning = true;
    job.start();
  }

  stopCron() {
    const job = this.schedulerRegistry.getCronJob('crawler');
    this.isRunning = false;
    job.stop();
  }

  getCronStatus(): boolean {
    return this.isRunning;
  }
}
