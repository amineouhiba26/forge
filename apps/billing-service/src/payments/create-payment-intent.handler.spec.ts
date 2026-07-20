import { toMinorUnits } from './create-payment-intent.handler';

describe('toMinorUnits', () => {
  it('converts a decimal string to integer cents', () => {
    expect(toMinorUnits('1200.00')).toBe(120000);
    expect(toMinorUnits('19.99')).toBe(1999);
    expect(toMinorUnits('0.01')).toBe(1);
  });

  it('avoids the float multiplication that loses a cent', () => {
    // `19.99 * 100` is 1998.9999999999998 in binary floating point, so
    // Math.round-based conversions of certain values charge a cent short.
    // Reading the digits from the already-exact decimal string cannot drift.
    expect(toMinorUnits('19.99')).toBe(1999);
    expect(toMinorUnits('1.10')).toBe(110);
    expect(toMinorUnits('8.20')).toBe(820);
    expect(toMinorUnits('0.29')).toBe(29);
  });

  it('handles a whole amount with no decimal point', () => {
    expect(toMinorUnits('500')).toBe(50000);
  });

  it('handles a single decimal place', () => {
    // Decimal(12,2) always renders two places, but a caller passing "5.5"
    // must not become 5 cents.
    expect(toMinorUnits('5.5')).toBe(550);
  });

  it('keeps a large amount exact', () => {
    expect(toMinorUnits('99999.99')).toBe(9999999);
  });
});
