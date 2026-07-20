/**
 * Intent: "create an invoice for this completed milestone."
 *
 * A command is a request to change state. It is named imperatively, it has
 * exactly one handler, and it may be rejected — unlike an event, which
 * describes something that already happened and cannot be refused.
 */
export class CreateInvoiceCommand {
  constructor(
    public readonly tenantId: string,
    public readonly milestoneId: string,
    public readonly correlationId: string,
  ) {}
}

/**
 * The compensating command. Dispatched by the saga when PDF generation fails.
 *
 * A separate command rather than a method call inside the saga, so the failure
 * path goes through the same dispatch, logging and testing machinery as the
 * happy path. A compensating action that bypasses the bus is one nobody can
 * observe.
 */
export class MarkGenerationFailedCommand {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly reason: string,
    public readonly correlationId: string,
  ) {}
}

/** Records a successful render and moves the invoice to ISSUED. */
export class MarkInvoiceIssuedCommand {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly pdfUrl: string,
    public readonly correlationId: string,
  ) {}
}
