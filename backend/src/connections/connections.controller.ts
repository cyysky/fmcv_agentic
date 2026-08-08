import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Connection } from '@prisma/client';
import { ConnectionTestResult, ConnectionsService } from './connections.service';
import { CreateConnectionDto, UpdateConnectionDto } from './dto/connection.dto';

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Post()
  create(@Body() dto: CreateConnectionDto): Promise<Connection> {
    return this.connectionsService.create(dto);
  }

  @Get()
  findAll(): Promise<Connection[]> {
    return this.connectionsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Connection> {
    return this.connectionsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConnectionDto,
  ): Promise<Connection> {
    return this.connectionsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.connectionsService.remove(id);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(@Param('id', ParseUUIDPipe) id: string): Promise<ConnectionTestResult> {
    return this.connectionsService.test(id);
  }
}
