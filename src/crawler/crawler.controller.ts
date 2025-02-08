// src/crawler/crawler.controller.ts
import { Controller, Get } from '@nestjs/common';
import { CrawlerService } from './crawler.service';

@Controller('crawler')
export class CrawlerController {
  constructor(private readonly crawlerService: CrawlerService) {}

  @Get('run')
  runCrawler() {
    this.crawlerService.run(); // 手动触发爬虫任务
    return 'Crawler task started!';
  }
}
