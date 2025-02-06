import { load } from 'cheerio';
import { Logger } from '@nestjs/common';

export class CrawlerLogic {
  private readonly logger = new Logger(CrawlerLogic.name);
  async run() {
    this.logger.log('开始执行爬虫任务...');
    try {
      const res = await fetch('http://www.zuanke8.com/forum-15-1.html');
      const arrayBuffer = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(arrayBuffer);

      const $ = load(text);
      console.log($('tbody tr .new a').text());
    } catch (error) {
      this.logger.error('爬虫任务失败', error);
    }
  }
}
