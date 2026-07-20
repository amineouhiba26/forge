import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

export interface InvoiceEmail {
  to: string;
  recipientName: string;
  invoiceId: string;
  total: string;
  currency: string;
  pdfPath: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;

  constructor(private readonly config: ConfigService) {
    const user = this.config.get<string>('SMTP_USER');
    const password = this.config.get<string>('SMTP_PASSWORD');

    this.transporter = createTransport({
      host: this.config.getOrThrow<string>('SMTP_HOST'),
      port: this.config.getOrThrow<number>('SMTP_PORT'),
      // Local development targets Mailpit, which speaks plaintext SMTP on
      // 1025. `secure` is derived from the port rather than hardcoded so a
      // real provider on 465 works without a code change.
      secure: this.config.getOrThrow<number>('SMTP_PORT') === 465,
      auth: user ? { user, pass: password } : undefined,
    });
  }

  /**
   * Sends an invoice with its PDF attached.
   *
   * Deliberately has no retry of its own. Retrying here would nest a retry
   * loop inside BullMQ's, so a single job could send five times while the
   * queue believed it had made one attempt — and the backoff the queue applies
   * between attempts would be meaningless. Throwing is the correct response;
   * the queue owns the policy.
   */
  async sendInvoice(email: InvoiceEmail): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.getOrThrow<string>('MAIL_FROM'),
      to: email.to,
      subject: `Invoice ${email.invoiceId} — ${email.total} ${email.currency}`,
      text:
        `Hello ${email.recipientName},\n\n` +
        `Please find attached invoice ${email.invoiceId} for ` +
        `${email.total} ${email.currency}.\n\n` +
        `Thank you.`,
      attachments: [
        {
          filename: `invoice-${email.invoiceId}.pdf`,
          path: email.pdfPath,
        },
      ],
    });

    this.logger.log(`Invoice ${email.invoiceId} emailed to ${email.to}`);
  }
}
