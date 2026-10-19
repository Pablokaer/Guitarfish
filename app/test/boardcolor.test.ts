import { describe, expect, it } from "vitest";
import { BoardColor } from "../src/boardcolor";

/** A 40×20 RGBA picture: board colours on the left, `cover` on the right half. */
function picture(board: [number, number, number][], cover: [number, number, number]) {
  const w = 40, h = 20;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = x < 20 ? board[(x + y) % board.length] : cover;
      px.set([...c, 255], (y * w + x) * 4);
    }
  }
  const left: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < 20; x++) left.push([x, y]);
  return { px, w, h, left };
}

// Rosewood with fret wire, strings and a pearl dot.
const ROSEWOOD: [number, number, number][] = [[70, 42, 30], [62, 38, 28], [80, 50, 36], [175, 175, 170], [140, 140, 135], [220, 215, 200]];
const MAPLE: [number, number, number][] = [[226, 180, 132], [212, 166, 120], [200, 150, 110], [175, 175, 170]];

describe("BoardColor", () => {
  it("tells a hand from a dark board once it has seen enough of the board", () => {
    const b = new BoardColor();
    const { px, w, h, left } = picture(ROSEWOOD, [205, 150, 120]);
    expect(b.covered(px, w, h, 30, 10)).toBe(false); // knows nothing yet
    for (let i = 0; i < 3; i++) b.learn(px, w, h, left);
    expect(b.discriminates).toBe(true);
    expect(b.covered(px, w, h, 30, 10)).toBe(true); // the hand
    expect(b.covered(px, w, h, 5, 5)).toBe(false); // the board
  });

  it("covers nothing on a pale board a hand looks like", () => {
    const b = new BoardColor();
    const { px, w, h, left } = picture(MAPLE, [205, 150, 120]);
    for (let i = 0; i < 3; i++) b.learn(px, w, h, left);
    expect(b.discriminates).toBe(false);
    expect(b.covered(px, w, h, 30, 10)).toBe(false);
  });

  it("forgets the board after a reset", () => {
    const b = new BoardColor();
    const { px, w, h, left } = picture(ROSEWOOD, [205, 150, 120]);
    for (let i = 0; i < 3; i++) b.learn(px, w, h, left);
    b.reset();
    expect(b.covered(px, w, h, 30, 10)).toBe(false);
  });
});
