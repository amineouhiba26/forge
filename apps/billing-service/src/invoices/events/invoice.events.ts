/**
 * Events describe what *has happened*. Past tense, and never rejected — by the
 * time one is published the state change is already committed.
 *
 * The distinction from a command matters: a command has exactly one handler
 * and can fail; an event may have zero or many subscribers and cannot. That is
 * what lets the saga, and later the notification and reporting concerns, react
 * to an invoice being created without the command handler knowing they exist.
 */
export class InvoiceCreatedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly milestoneId: string,
    public readonly total: string,
    public readonly currency: string,
    public readonly correlationId: string,
  ) {}
}

export class InvoiceIssuedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly pdfUrl: string,
    public readonly correlationId: string,
  ) {}
}

/**
 * Emitted when PDF generation fails and the invoice has been moved to
 * GENERATION_FAILED. The saga listens for this to queue a retry.
 */
export class InvoiceGenerationFailedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly reason: string,
    public readonly attempts: number,
    public readonly correlationId: string,
  ) {}
}
