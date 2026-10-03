import { Global, Module } from '@nestjs/common';
import { EmailConfig } from '../../config/domains/email.config';
import { EmailService } from './email.service';

@Global()
@Module({
  providers: [{ provide: EmailService, useFactory: (config: EmailConfig) => new EmailService(config), inject: [EmailConfig] }],
  exports: [EmailService],
})
export class EmailModule {}
