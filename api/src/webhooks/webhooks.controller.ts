import { Controller, Post, Param, Req, Headers, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';
import { Public } from '../auth/decorators/public.decorator';

// Signed by HMAC, not by a session — bypass the JWT guard.
@ApiTags('Webhooks')
@Public()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post(':vendor')
  @HttpCode(200)
  async receive(
    @Param('vendor') vendor: string,
    @Headers('x-webhook-key') keyId: string | undefined,
    @Headers('x-signature') signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    const result = await this.webhooks.ingest({
      vendorParam: vendor,
      keyId,
      signatureHeader: signature,
      rawBody: req.rawBody,
      body: req.body,
    });
    return result;
  }
}
