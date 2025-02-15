import { Controller, Get } from '@nestjs/common';
import { CrawlerService } from './crawler.service';

@Controller('crawler')
export class CrawlerController {
  constructor(private readonly crawlerService: CrawlerService) {}

  @Get('run')
  async runCrawler() {
    await this.crawlerService.handleCron(); // 手动触发爬虫任务
    return 'Crawler task started!';
  }

  @Get('start')
  startCrawler() {
    this.crawlerService.startCron();
    return 'Crawler schedule started!';
  }

  @Get('stop')
  stopCrawler() {
    this.crawlerService.stopCron();
    return 'Crawler schedule stopped!';
  }

  @Get('status')
  getStatus() {
    return this.crawlerService.getCronStatus();
  }
}
