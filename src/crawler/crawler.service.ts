import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as cheerio from 'cheerio';

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);

  @Cron(CronExpression.EVERY_MINUTE) // 每分钟执行一次
  async handleCron() {
    this.logger.log('开始执行爬虫任务...');
    try {
      const res = await fetch('http://www.zuanke8.com/forum-15-1.html');
      const arrayBuffer = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(arrayBuffer);

      const $ = cheerio.load(text);
      console.log($('tbody tr .new a').text());
    } catch (error) {
      this.logger.error('爬虫任务失败', error);
    }
  }
}
