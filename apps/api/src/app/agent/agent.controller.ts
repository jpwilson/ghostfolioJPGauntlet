import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Res,
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { CoreMessage } from 'ai';
import { Response } from 'express';
import { join } from 'node:path';

import { AgentService } from './agent.service';

interface ChatRequestBody {
  messages: CoreMessage[];
}

@Controller('agent')
export class AgentController {
  public constructor(
    private readonly agentService: AgentService,
    @Inject(REQUEST) private readonly request: RequestWithUser
  ) {}

  @Get('ui')
  public serveChat(@Res() res: Response) {
    const fs = require('node:fs');
    const path = require('node:path');

    // Try source path first (dev), then dist path
    const paths = [
      path.join(process.cwd(), 'apps', 'api', 'src', 'app', 'agent', 'agent-chat.html'),
      path.join(__dirname, 'agent-chat.html')
    ];

    for (const p of paths) {
      if (fs.existsSync(p)) {
        return res.sendFile(p);
      }
    }

    return res.status(404).send('Chat UI not found');
  }

  @Post('chat')
  @HasPermission(permissions.createOrder)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async chat(@Body() body: ChatRequestBody) {
    if (!body.messages?.length) {
      throw new HttpException(
        'Messages array is required',
        HttpStatus.BAD_REQUEST
      );
    }

    try {
      const result = await this.agentService.chat({
        messages: body.messages,
        userId: this.request.user.id
      });

      return result;
    } catch (error) {
      throw new HttpException(
        `Agent error: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
