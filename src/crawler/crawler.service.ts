import { Injectable } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CrawlerLogic } from './crawler.logic';
import { PrismaService } from 'nestjs-prisma';

@Injectable()
export class CrawlerService {
  private isRunning: boolean = true;

  constructor(
    private readonly crawlerLogic: CrawlerLogic,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly prisma: PrismaService,
  ) {}
  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'crawler',
  }) // 每5分钟执行一次
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
