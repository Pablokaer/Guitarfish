import { describe, expect, it } from "vitest";
import { CropPlan, cropAround, drawCrop, fromCrop, fullFrame, searchCrops, turnedFrame } from "../src/neckcrop";
import { apply, homography, planePoint, type Calibration, type Pt } from "../src/neckmap";

/** A neck in a 1920×1080 frame: nut at `nut`, 12th fret `len` px away along `deg` (clockwise on screen). */
function neck(nut: Pt, len: number, deg: number): Calibration {
  const a = (deg * Math.PI) / 180;
  const along: Pt = [Math.cos(a), Math.sin(a)];
  const across: Pt = [-Math.sin(a), Math.cos(a)];
  const at = (d: number, off: number): Pt => [nut[0] + along[0] * d + across[0] * off, nut[1] + along[1] * d + across[1] * off];
  const H = homography([[0, -0.05], [0, 0.05], [1, -0.07], [1, 0.07]], [at(0, 20), at(0, -20), at(len, 30), at(len, -30)])!;
  return [0, 5].flatMap((s) => [0, 1].map((x) => ({ x, s }))).sort((p, q) => p.x - q.x || p.s - q.s).map(({ x, s }) => apply(H, planePoint(x, s, 6))) as unknown as Calibration;
}

describe("cropAround", () => {
  it("boxes a level neck up to the 15th fret, with room, in the frame's shape", () => {
    const c = cropAround(neck([700, 540], 300, 0), 6, 1920, 1080);
    expect(c.angle).toBe(0);
    expect(c.w / c.h).toBeCloseTo(16 / 9);
    expect(c.cx - c.w / 2).toBeLessThan(700);
    expect(c.cx + c.w / 2).toBeGreaterThan(1100);
    expect(c.w).toBeGreaterThanOrEqual(1920 / 4);
  });

  it("turns with a neck held at 2 or 4 o'clock, never upside down", () => {
    expect(cropAround(neck([700, 700], 300, -35), 6, 1920, 1080).angle).toBeCloseTo((-35 * Math.PI) / 180, 1);
    expect(cropAround(neck([700, 400], 300, 30), 6, 1920, 1080).angle).toBeCloseTo((30 * Math.PI) / 180, 1);
    // Nut on the right, neck going down-left: still within a quarter turn of level.
    const c = cropAround(neck([1300, 400], 300, 150), 6, 1920, 1080);
    expect(Math.abs(c.angle)).toBeLessThanOrEqual(Math.PI / 2);
    expect(c.angle).toBeCloseTo((-30 * Math.PI) / 180, 1);
  });

  it("holds the whole neck in its box when turned", () => {
    const cal = neck([700, 700], 300, -40);
    const c = cropAround(cal, 6, 1920, 1080);
    // Every corner of the neck, in the model's square, lies inside it.
    const inv = (p: Pt): Pt => {
      const [dx, dy] = [p[0] - c.cx, p[1] - c.cy];
      const [cos, sin] = [Math.cos(c.angle), Math.sin(c.angle)];
      return [((dx * cos + dy * sin) / c.w + 0.5) * 640, ((-dx * sin + dy * cos) / c.h + 0.5) * 640];
    };
    for (const p of cal) {
      const [u, v] = inv(p);
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(640);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(640);
    }
  });

  it("gives the whole frame when a level neck fills most of it", () => {
    expect(cropAround(neck([250, 540], 1050, 0), 6, 1920, 1080)).toEqual(fullFrame(1920, 1080));
  });

  it("zooms out past the frame when the neck is seen so close its frets are huge", () => {
    // Nut to 12th fret 3000 px: only a few frets are in the 1920 px frame.
    const c = cropAround(neck([-1500, 540], 3000, 0), 6, 1920, 1080);
    expect(c.w).toBeGreaterThan(1920);
    // The neck's nut-to-12th length is at most 60% of the box.
    expect(3000 / c.w).toBeLessThanOrEqual(0.6 + 1e-9);
  });
});

describe("fromCrop", () => {
  it("maps the model's square back into the frame, turn included", () => {
    const level = { cx: 420, cy: 230, w: 640, h: 360, angle: 0 };
    expect(fromCrop(level, 640, [320, 320])).toEqual([420, 230]);
    const p = fromCrop({ ...level, angle: Math.PI / 2 }, 640, [640, 320]); // right edge, middle
    expect(p[0]).toBeCloseTo(420);
    expect(p[1]).toBeCloseTo(230 + 320);
  });
});

describe("searchCrops", () => {
  it("starts with the whole frame, level and turned either way", () => {
    const cs = searchCrops(1920, 1080);
    expect(cs[0]).toEqual(fullFrame(1920, 1080));
    expect(cs.some((c) => c.angle > 0)).toBe(true);
    expect(cs.some((c) => c.angle < 0)).toBe(true);
  });

  it("covers the whole frame when turned", () => {
    const c = turnedFrame(1920, 1080, 0.6);
    for (const corner of [[0, 0], [1920, 0], [0, 1080], [1920, 1080]] as Pt[]) {
      const [dx, dy] = [corner[0] - c.cx, corner[1] - c.cy];
      const [cos, sin] = [Math.cos(c.angle), Math.sin(c.angle)];
      expect(Math.abs(dx * cos + dy * sin)).toBeLessThanOrEqual(c.w / 2 + 1e-6);
      expect(Math.abs(-dx * sin + dy * cos)).toBeLessThanOrEqual(c.h / 2 + 1e-6);
    }
  });
});

describe("drawCrop", () => {
  it("clears the square, then draws the frame moved, turned and scaled so the box fills it", () => {
    const calls: string[] = [];
    const ctx = {
      fillStyle: "",
      setTransform: (...a: number[]) => calls.push(`setTransform ${a.join(",")}`),
      fillRect: (...a: number[]) => calls.push(`fillRect ${a.join(",")}`),
      translate: (x: number, y: number) => calls.push(`translate ${x},${y}`),
      scale: (x: number, y: number) => calls.push(`scale ${x},${y}`),
      rotate: (a: number) => calls.push(`rotate ${a}`),
      drawImage: () => calls.push("drawImage"),
    } as unknown as CanvasRenderingContext2D;
    drawCrop(ctx, {} as CanvasImageSource, { cx: 400, cy: 300, w: 320, h: 160, angle: 0.5 }, 640);
    expect(calls).toEqual([
      "setTransform 1,0,0,1,0,0",
      "fillRect 0,0,640,640",
      "translate 320,320",
      "scale 2,4",
      "rotate -0.5",
      "translate -400,-300",
      "drawImage",
      "setTransform 1,0,0,1,0,0",
    ]);
  });

  it("filters properly when it shrinks the frame, and bilinear when it blows it up", () => {
    const quality = (w: number, h: number) => {
      const ctx = { setTransform() {}, fillRect() {}, translate() {}, scale() {}, rotate() {}, drawImage() {} } as unknown as CanvasRenderingContext2D;
      drawCrop(ctx, {} as CanvasImageSource, { cx: 0, cy: 0, w, h, angle: 0 }, 640);
      return [ctx.imageSmoothingEnabled, ctx.imageSmoothingQuality];
    };
    expect(quality(1920, 1080)).toEqual([true, "high"]);
    expect(quality(1280, 320)).toEqual([true, "high"]);
    expect(quality(480, 270)).toEqual([true, "low"]);
  });
});

describe("CropPlan", () => {
  it("searches the frame in turn while the neck isn't known, then looks around it, now and then at the whole frame", () => {
    const plan = new CropPlan();
    const searches = searchCrops(1920, 1080);
    expect(plan.next(null, 6, 1920, 1080)).toEqual(searches[0]);
    expect(plan.next(null, 6, 1920, 1080)).toEqual(searches[1]);
    const cal = neck([700, 540], 300, 0);
    const looks = Array.from({ length: 6 }, () => plan.next(cal, 6, 1920, 1080));
    expect(looks.slice(0, 5).every((c) => c.w < 1920)).toBe(true);
    expect(looks[5]).toEqual(fullFrame(1920, 1080));
  });
});
