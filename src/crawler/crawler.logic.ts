import { load } from 'cheerio';
import { Logger } from '@nestjs/common';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

export class CrawlerLogic {
  private readonly logger = new Logger(CrawlerLogic.name);
  async run() {
    this.logger.log('开始执行爬虫任务...');
    try {
      const res = await fetch('http://www.zuanke8.com/forum-15-1.html');
      const arrayBuffer = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(arrayBuffer);

      const $ = load(text);
      const list: any[] = [];
      $('tbody tr').each((_index, item) => {
        const newItem = $(item).find('.new a');
        if (newItem.length > 0) {
          const titleInfo = newItem.map((_index, item) => {
            return {
              title: $(item).text(),
              href: $(item).attr('href'),
            };
          })[0];

          const createTime = $(item).find('em span').text();
          list.push({
            ...titleInfo,
            createTime,
          });
        }
      });

      console.log(list);
      // console.log(.text());
    } catch (error) {
      this.logger.error('爬虫任务失败', error);
    }
  }

  /**
   * Ai 分析标题
   */
  async aiAnalysisTitle(title: string) {
    this.logger.log('开始执行Ai分析标题任务...');

    const model = new ChatOpenAI({
      modelName: 'deepseek-chat',
      configuration: {
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-4cbbb5c94b5b4e0590e8a09dd8fd42ac',
      },
    });

    const prompt = PromptTemplate.fromTemplate(
      '你是一个文章分类系统，你的任务是根据文章标题{title}给出这个文章的信息。\n{instructions}',
    );
    const schema = z.object({
      type: z.string().describe('文章的类型'),
      area: z.string().nullable().describe('活动的地点'),
    });

    const parser = StructuredOutputParser.fromZodSchema(schema);

    const chain = prompt.pipe(model).pipe(parser);
    const res = await chain.invoke({
      title,
      instructions: parser.getFormatInstructions(),
    });

    return res;
  }
}
