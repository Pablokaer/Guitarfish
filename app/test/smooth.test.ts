import { describe, expect, it } from "vitest";
import { OneEuro } from "../src/smooth";

describe("OneEuro", () => {
  it("smooths jitter when still", () => {
    const f = new OneEuro(0.8, 0.015);
    let last = 0;
    for (let i = 0; i < 60; i++) last = f.next(100 + (i % 2 ? 3 : -3), i * 33);
    expect(Math.abs(last - 100)).toBeLessThan(1.5);
  });

  it("keeps up with a steady move", () => {
    const f = new OneEuro(0.8, 0.015);
    let last = 0;
    // 600 px/s for a second.
    for (let i = 0; i <= 30; i++) last = f.next(i * 20, i * 33);
    expect(600 - last).toBeLessThan(60);
  });

  it("starts again after a reset", () => {
    const f = new OneEuro();
    f.next(0, 0);
    f.reset();
    expect(f.next(500, 10)).toBe(500);
  });
});
