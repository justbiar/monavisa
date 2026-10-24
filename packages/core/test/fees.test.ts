import { describe, expect, it } from "vitest";
import { computeFee, renewalCharge, splitPayment } from "../src/index.js";

describe("fees", () => {
  it("computes F = rho * P in basis points", () => {
    expect(computeFee(49_000_000n, 100)).toBe(490_000n); // 1% of 49 USDC
    expect(computeFee(49_000_000n, 0)).toBe(0n);
    expect(computeFee(49_000_000n, 10_000)).toBe(49_000_000n);
  });

  it("rounds down", () => {
    expect(computeFee(1n, 9_999)).toBe(0n);
    expect(computeFee(999n, 100)).toBe(9n);
  });

  it("keeps fee + merchant equal to the amount", () => {
    for (const amount of [0n, 1n, 7n, 1_000n, 12_345_678n]) {
      for (const bps of [0, 1, 50, 250, 9_999, 10_000]) {
        const { fee, merchant } = splitPayment(amount, bps);
        expect(fee + merchant).toBe(amount);
      }
    }
  });

  it("adds the renewal fee on top of the plan price", () => {
    expect(renewalCharge(49_000_000n, 100)).toEqual({
      fee: 490_000n,
      merchant: 49_000_000n,
      total: 49_490_000n,
    });
  });

  it("rejects invalid input", () => {
    expect(() => computeFee(-1n, 100)).toThrow(RangeError);
    expect(() => computeFee(1n, -1)).toThrow(RangeError);
    expect(() => computeFee(1n, 10_001)).toThrow(RangeError);
    expect(() => computeFee(1n, 1.5)).toThrow(RangeError);
  });
});
