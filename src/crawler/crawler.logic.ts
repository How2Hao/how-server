import { load } from 'cheerio';
import { Logger } from '@nestjs/common';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { OpenAI } from 'openai';
import { ConfigService } from '@nestjs/config';
import { md5Encrypt } from 'src/utils';
import { Parser } from 'xml2js';
import JSON5 from 'json5';

export class CrawlerLogic {
  private readonly logger = new Logger(CrawlerLogic.name);
  private readonly config = new ConfigService();
  private readonly xmlParser = new Parser({
    explicitArray: false,
    trim: true,
  });
  private readonly apiKey = this.config.get<string>('SF_API_KEY');
  private Cookie: string[];
  private HOST: string = 'http://www.zuanke8.com/';

  /**
   * 通过HTML地址获取页面内容
   */
  async getHtml(url: string, label: string = 'gbk') {
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    const html = new TextDecoder(label).decode(arrayBuffer);
    return load(html);
  }

  /**
   * 模拟登录
   */
  async login() {
    const $ = await this.getHtml(
      'http://www.zuanke8.com/member.php?mod=logging&action=login',
    );
    const parmas = $('form[name="login"]').attr('action');

    const formData = new URLSearchParams();
    formData.append('formhash', $('input[name="formhash"]').val() as string);
    formData.append('referer', 'http://www.zuanke8.com/');
    formData.append('loginfield', 'username');
    formData.append('username', 'flippedround');
    formData.append('password', md5Encrypt('zy500233'));
    formData.append('questionid', '7');
    formData.append('answer', '0010');

    const res = await fetch(this.HOST + parmas, {
      method: 'POST',
      body: formData.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      redirect: 'manual',
    });

    this.Cookie = res.headers.getSetCookie();
  }

  async run() {
    this.logger.log('开始执行爬虫任务...');
    try {
      const $ = await this.getHtml('http://www.zuanke8.com/forum-15-1.html');
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
   * 轮询获取数据
   */
  async polling() {
    this.logger.log('开始执行轮询任务...');
    const baseUrl = new URL('http://www.zuanke8.com/forum.php');
    const time = Math.floor((Date.now() - 60000) / 1000).toString();
    const params = new URLSearchParams({
      mod: 'ajax',
      action: 'forumchecknew',
      fid: '15',
      time,
      inajax: 'yes',
    });

    // 将查询参数附加到 URL
    baseUrl.search = params.toString();
    const res = await fetch(baseUrl.toString());
    const text = await res.text();
    const data = await this.xmlParser.parseStringPromise(text);
    this.logger.log('获取到' + data.root + '条数据');
    if (data.root !== '0') this.getUpdateContent(time);
  }

  /**
   * 获取更新内容
   */
  async getUpdateContent(time: string) {
    this.logger.log('开始执行获取更新内容任务...');
    const baseUrl = new URL('http://www.zuanke8.com/forum.php');
    const params = new URLSearchParams({
      mod: 'ajax',
      action: 'forumchecknew',
      fid: '15',
      time,
      uncheck: '1',
      inajax: '1',
      ajaxtarget: 'forumnew',
    });
    baseUrl.search = params.toString();
    const res = await fetch(baseUrl.toString());
    const arrayBuffer = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(arrayBuffer);
    const data = await this.xmlParser.parseStringPromise(text);
    const cdataContent = data.root as string;
    const regex = /newthread\[\d+\]\s*=\s*(\{.*?})\s*;/gs;
    const threads: any[] = [];
    let match;

    while ((match = regex.exec(cdataContent)) !== null) {
      const objStr = match[1];
      try {
        // 使用JSON5解析宽松格式的JS对象
        const thread = JSON5.parse(objStr);
        threads.push(thread);
      } catch (e) {
        console.error('解析失败:', e);
      }
    }

    console.log(threads); // 输出解析结果
  }

  /**
   * Ai 分析标题
   */
  async aiAnalysisTitleByLangchin(title: string) {
    this.logger.log('开始执行Ai分析标题任务...');
    console.time('aiAnalysisTitleByLangchin');
    const model = new ChatOpenAI({
      modelName: 'Qwen/Qwen2.5-7B-Instruct',
      configuration: {
        baseURL: 'https://api.siliconflow.cn/v1',
        apiKey: this.apiKey,
      },
    });

    const prompt = PromptTemplate.fromTemplate(
      '你是一个文章分类系统，你的任务是根据文章标题{title}给出这个文章的信息。\n{instructions}',
    );
    const schema = z.object({
      type: z.enum(['银行卡', '微信', '支付宝']).describe('文章的类型'),
      area: z.string().nullable().describe('活动的地点'),
    });

    const parser = StructuredOutputParser.fromZodSchema(schema);

    const chain = prompt.pipe(model).pipe(parser);
    const res = await chain.invoke({
      title,
      instructions: parser.getFormatInstructions(),
    });
    console.log(res);
    console.timeEnd('aiAnalysisTitleByLangchin');
    return res;
  }
  async aiAnalysisTitleBySiliconflow(title: string) {
    console.time('aiAnalysisTitleBySiliconflow');
    const client = new OpenAI({
      baseURL: 'https://api.siliconflow.cn/v1',
      apiKey: 'sk-ytxtsnfaqzbdocykbvcbttuehzzscytubvczewvwnezueodx',
    });

    const res = await client.chat.completions.create({
      model: 'Qwen/Qwen2.5-7B-Instruct',
      messages: [
        {
          role: 'system',
          content:
            '你是一个文章分类系统，你的任务是根据文章标题给出这个文章的信息。',
        },
        {
          role: 'assistant',
          content: `Please respond in the format {"type": ..., "area": ...}`,
        },
        {
          role: 'user',
          content: `文章标题是：${title}`,
        },
      ],
      response_format: {
        type: 'json_object',
      },
    });
    console.log(res.choices[0].message.content);
    console.timeEnd('aiAnalysisTitleBySiliconflow');
  }
}
