import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';

import { WORKER_PATTERNS } from '@forge/contracts';
import type { GeneratePdfRequest, GeneratePdfResult } from '@forge/contracts';

/**
 * PDF generation — a placeholder until Sprint 5.
 *
 * Sprint 5 replaces this with a real renderer (Puppeteer or PDFKit) driven by
 * a BullMQ job. What matters *now* is that the saga has something that can
 * genuinely succeed or fail, because the compensating path is only real if it
 * can be exercised.
 *
 * `FORCE_PDF_FAILURE` is what makes that testable: without a way to make
 * generation fail on demand, the compensation branch would be written but
 * never run — and untested error handling is usually broken error handling.
 */
@Controller()
export class PdfController {
  private readonly logger = new Logger(PdfController.name);

  @MessagePattern(WORKER_PATTERNS.GENERATE_INVOICE_PDF)
  generateInvoicePdf(
    @Payload() payload: GeneratePdfRequest,
  ): GeneratePdfResult {
    const { invoiceId, correlationId } = payload;

    if (process.env.FORCE_PDF_FAILURE === 'true') {
      this.logger.warn(
        `Forced PDF failure for invoice ${invoiceId} (correlationId=${correlationId})`,
      );

      throw new RpcException({
        status: 500,
        message: 'PDF renderer unavailable',
      });
    }

    this.logger.log(
      `Generated PDF for invoice ${invoiceId} (correlationId=${correlationId})`,
    );

    // Sprint 5 writes to disk or S3-compatible storage and returns a real
    // location. The shape of the reply is already the one that will be used.
    return { pdfUrl: `/invoices/${invoiceId}.pdf` };
  }
}
