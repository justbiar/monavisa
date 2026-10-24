import { describe, expect, it } from "vitest";
import { checkoutSteps, describePeriod, formatAmount } from "../src/format.js";

describe("format", () => {
  it("names common billing periods", () => {
    expect(describePeriod(30 * 86_400)).toBe("month");
    expect(describePeriod(365 * 86_400)).toBe("year");
    expect(describePeriod(7 * 86_400)).toBe("week");
    expect(describePeriod(86_400)).toBe("day");
    expect(describePeriod(14 * 86_400)).toBe("14 days");
    expect(describePeriod(3600)).toBe("hour");
    expect(describePeriod(12 * 3600)).toBe("12 hours");
  });

  it("formats USDC base units", () => {
    expect(formatAmount(49_000_000n, 6)).toBe("49");
    expect(formatAmount(49_490_000n, 6)).toBe("49.49");
    expect(formatAmount(1_234_567_890n, 6)).toBe("1,234.56");
    expect(formatAmount(5n, 6)).toBe("0");
    expect(formatAmount(5n, 6, 6)).toBe("0.000005");
  });

  it("skips the Permit2 approval when the existing one is enough", () => {
    expect(checkoutSteps(0n, 100n)).toEqual(["approve", "sign", "subscribe"]);
    expect(checkoutSteps(99n, 100n)).toEqual(["approve", "sign", "subscribe"]);
    expect(checkoutSteps(100n, 100n)).toEqual(["sign", "subscribe"]);
  });

  it("authorizes on-chain for accounts with code", () => {
    expect(checkoutSteps(0n, 100n, true)).toEqual(["approve", "authorize", "subscribe"]);
    expect(checkoutSteps(100n, 100n, true)).toEqual(["authorize", "subscribe"]);
  });
});
