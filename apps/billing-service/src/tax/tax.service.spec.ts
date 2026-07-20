import { TaxService, calculateTax } from './tax.service';

describe('TaxService', () => {
  const service = new TaxService();

  it('resolves the standard rate for a known country', () => {
    expect(service.rateForCountry('FR')).toBe(20);
    expect(service.rateForCountry('DE')).toBe(19);
    expect(service.rateForCountry('LU')).toBe(17);
  });

  it('is case-insensitive, since country codes arrive from several sources', () => {
    expect(service.rateForCountry('fr')).toBe(20);
  });

  it('returns zero for an unknown country rather than guessing', () => {
    // An invoice carrying a guessed rate is a legal document with the wrong
    // number on it. Zero is the correct treatment for most out-of-scope
    // supplies, and it is visible on the invoice as something to check.
    expect(service.rateForCountry('ZZ')).toBe(0);
  });
});

describe('calculateTax', () => {
  it('splits an amount into tax and total', () => {
    expect(calculateTax(1000, 20)).toEqual({ taxAmount: 200, total: 1200 });
  });

  it('rounds to the cent so the lines always add up', () => {
    // 33.33 at 20% is 6.666, which must not reach the invoice as 6.67 while
    // the total was computed from 6.666.
    const { taxAmount, total } = calculateTax(33.33, 20);

    expect(taxAmount).toBe(6.67);
    expect(total).toBe(40);
    expect(Number((33.33 + taxAmount).toFixed(2))).toBe(total);
  });

  it('handles a zero rate', () => {
    expect(calculateTax(500, 0)).toEqual({ taxAmount: 0, total: 500 });
  });

  it('survives the classic floating point rounding case', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in binary floating point; the
    // epsilon correction in roundToCents is what keeps this exact.
    expect(calculateTax(0.1, 20).taxAmount).toBe(0.02);
    expect(calculateTax(1.005, 100).taxAmount).toBe(1.01);
  });

  it('keeps a large amount exact', () => {
    const { taxAmount, total } = calculateTax(99999.99, 20);

    expect(taxAmount).toBe(20000);
    expect(total).toBe(119999.99);
  });
});
