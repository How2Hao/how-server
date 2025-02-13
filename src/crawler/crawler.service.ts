import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CrawlerLogic } from './crawler.logic';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CrawlerService {
  constructor(
    private readonly crawlerLogic: CrawlerLogic,
    private configService: ConfigService,
  ) {}
  // @Cron(CronExpression.EVERY_MINUTE) // 每分钟执行一次
  async handleCron() {
    await this.crawlerLogic.run();
  }

  async run() {
    await this.crawlerLogic.aiAnalysisTitleByLangchin(
      '广州民生借记卡2元立减金',
    );
    // await this.crawlerLogic.aiAnalysisTitleBySiliconflow(
    //   '广州民生借记卡2元立减金',
    // );
  }
  async login() {
    await this.crawlerLogic.login();
  }
}
