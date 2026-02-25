import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { CoreMessage } from 'ai';
import { Response } from 'express';

import { AgentService } from './agent.service';

interface ChatRequestBody {
  conversationId?: string;
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

    // Try source path first (dev), then dist paths
    const paths = [
      path.join(
        process.cwd(),
        'apps',
        'api',
        'src',
        'app',
        'agent',
        'agent-chat.html'
      ),
      path.join(__dirname, 'agent-chat.html'),
      path.join(process.cwd(), 'agent-chat.html')
    ];

    for (const p of paths) {
      if (fs.existsSync(p)) {
        return res.sendFile(p);
      }
    }

    return res.status(404).send('Chat UI not found');
  }

  @Get('video')
  public serveVideo(@Res() res: Response) {
    const fs = require('node:fs');
    const path = require('node:path');

    const paths = [
      path.join(
        process.cwd(),
        'apps',
        'api',
        'src',
        'assets',
        'ghostfolio_squash.webm'
      ),
      path.join(__dirname, '..', 'assets', 'ghostfolio_squash.webm'),
      path.join(process.cwd(), 'assets', 'ghostfolio_squash.webm')
    ];

    for (const p of paths) {
      if (fs.existsSync(p)) {
        res.setHeader('Content-Type', 'video/webm');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(p);
      }
    }

    return res.status(404).send('Video not found');
  }

  @Get('conversations')
  @HasPermission(permissions.createOrder)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async listConversations() {
    return this.agentService.listConversations({
      userId: this.request.user.id
    });
  }

  @Get('conversations/:id')
  @HasPermission(permissions.createOrder)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getConversation(@Param('id') id: string) {
    return this.agentService.getConversation({
      conversationId: id,
      userId: this.request.user.id
    });
  }

  @Delete('conversations/:id')
  @HasPermission(permissions.createOrder)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async deleteConversation(@Param('id') id: string) {
    return this.agentService.deleteConversation({
      conversationId: id,
      userId: this.request.user.id
    });
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
        conversationId: body.conversationId,
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
