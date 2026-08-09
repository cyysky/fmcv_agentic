import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebService } from './web.service';

@Module({
  imports: [ConfigModule],
  providers: [WebService],
  exports: [WebService],
})
export class WebModule {}
