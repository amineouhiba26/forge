import { Injectable } from '@nestjs/common';

/**
 * VAT rates by ISO 3166-1 alpha-2 country, as a percentage.
 *
 * A lookup table, not a tax engine. Real VAT depends on the *customer's*
 * location as well as the supplier's, on whether the customer is
 * VAT-registered (B2B reverse charge), and on the category of service — and
 * the rates change by legislation. A production system delegates this to a
 * dedicated provider.
 *
 * This is deliberately the tenant's own country and standard rate, which is
 * what the backlog asks for. It is the right *shape* — a resolved rate stamped
 * onto the invoice at creation time — with a placeholder implementation.
 */
const VAT_RATES: Record<string, number> = {
  AT: 20,
  BE: 21,
  DE: 19,
  ES: 21,
  FI: 24,
  FR: 20,
  GR: 24,
  IE: 23,
  IT: 22,
  LU: 17,
  NL: 21,
  PL: 23,
  PT: 23,
  SE: 25,
  GB: 20,
};

@Injectable()
export class TaxService {
  /**
   * Returns the VAT percentage for a country.
   *
   * Unknown countries resolve to 0 rather than throwing. Charging a *guessed*
   * rate would be worse than charging none: an invoice with the wrong tax is a
   * legal document with the wrong figure on it, whereas zero is the correct
   * treatment for most out-of-scope supplies and is visible on the invoice as
   * something to check.
   */
  rateForCountry(country: string): number {
    return VAT_RATES[country.toUpperCase()] ?? 0;
  }
}

/**
 * Splits an amount into tax and total.
 *
 * Kept as a pure function so it is testable without the Nest container, and
 * so the rounding rule lives in exactly one place.
 */
export function calculateTax(
  subtotal: number,
  ratePercent: number,
): { taxAmount: number; total: number } {
  // Rounded to the cent at the point of calculation. Postgres would round on
  // insert anyway (the column is Decimal(12,2)), but then `subtotal + tax`
  // computed in the application could disagree with the stored `total` by a
  // cent — and an invoice whose lines do not add up is indefensible.
  const taxAmount = roundToCents((subtotal * ratePercent) / 100);

  return { taxAmount, total: roundToCents(subtotal + taxAmount) };
}

function roundToCents(value: number): number {
  // `Number.EPSILON` compensates for binary floating point: 1.005 is actually
  // stored as 1.00499999..., so a naive Math.round would give 1.00 rather
  // than 1.01. The amounts themselves live as Decimal in Postgres; this
  // guards the arithmetic that happens in between.
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
