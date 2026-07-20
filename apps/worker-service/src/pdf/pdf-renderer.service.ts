import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PDFDocument from 'pdfkit';

export interface InvoicePdfInput {
  invoiceId: string;
  tenantName: string;
  clientName: string;
  clientEmail: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
  currency: string;
  issuedAt: string;
}

/**
 * Renders invoice PDFs with PDFKit.
 *
 * PDFKit rather than Puppeteer, which the backlog offers as the alternative:
 * Puppeteer means shipping a headless Chromium — hundreds of megabytes in the
 * image, its own crash modes, and a sandbox to configure — to lay out a page of
 * text and numbers. It earns that cost when the document is HTML/CSS a designer
 * maintains. This one is a fixed layout drawn in code.
 */
@Injectable()
export class PdfRendererService {
  private readonly logger = new Logger(PdfRendererService.name);

  constructor(private readonly config: ConfigService) {}

  /** Absolute path of the directory PDFs are written to. */
  private storageRoot(): string {
    return resolve(this.config.getOrThrow<string>('STORAGE_DIR'));
  }

  /**
   * Renders and stores an invoice, returning the stored path.
   *
   * Deterministic filename — the same invoice always renders to the same path.
   * That is what makes the job naturally idempotent: a retry overwrites the
   * identical file rather than accumulating `invoice-1 (2).pdf`.
   *
   * Files are laid out per tenant so a stray path cannot cross tenants on
   * disk, mirroring the isolation the database enforces.
   */
  async renderInvoice(
    tenantId: string,
    input: InvoicePdfInput,
  ): Promise<string> {
    const directory = join(this.storageRoot(), 'invoices', tenantId);
    await mkdir(directory, { recursive: true });

    const path = join(directory, `${input.invoiceId}.pdf`);
    const buffer = await this.draw(input);

    // Written in one call rather than streamed straight to the path: a stream
    // that fails midway leaves a truncated file that looks valid to anything
    // checking existence. Buffering means the file appears complete or not at
    // all.
    await writeFile(path, buffer);

    this.logger.log(`Rendered invoice ${input.invoiceId} to ${path}`);

    return path;
  }

  private draw(input: InvoicePdfInput): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      const document = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];

      document.on('data', (chunk: Buffer) => chunks.push(chunk));
      document.on('end', () => resolvePromise(Buffer.concat(chunks)));
      document.on('error', reject);

      document.fontSize(24).text('INVOICE', { align: 'right' });
      document.moveDown();

      document.fontSize(10);
      document.text(`Invoice ID: ${input.invoiceId}`);
      document.text(`Issued: ${input.issuedAt}`);
      document.moveDown();

      document.fontSize(12).text('From', { underline: true });
      document.fontSize(10).text(input.tenantName);
      document.moveDown();

      document.fontSize(12).text('To', { underline: true });
      document.fontSize(10).text(input.clientName);
      document.text(input.clientEmail);
      document.moveDown(2);

      const money = (amount: string) => `${amount} ${input.currency}`;

      document.fontSize(10);
      document.text(`Subtotal:   ${money(input.subtotal)}`, { align: 'right' });
      document.text(`Tax (${input.taxRate}%): ${money(input.taxAmount)}`, {
        align: 'right',
      });
      document.moveDown(0.5);
      document.fontSize(14).text(`Total: ${money(input.total)}`, {
        align: 'right',
      });

      document.end();
    });
  }
}
