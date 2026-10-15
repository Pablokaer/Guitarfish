import * as alphaTab from "@coderline/alphatab";
import { buildTimeline, type PlayedBar, type TempoChange, type TimedBar } from "./timeline";

/**
 * Reads what follow mode and the practice tools need from a loaded alphaTab score.
 * No DOM: it runs alphaTab's own MIDI generator, which expands repeats, alternate
 * endings and D.C./D.S./Coda/Fine directions exactly like alphaTab's player does.
 */

/** Ignores the MIDI events; only the generator's tick lookup is used. */
const noMidi: alphaTab.midi.IMidiFileHandler = {
  addTimeSignature() {},
  addRest() {},
  addNote() {},
  addControlChange() {},
  addProgramChange() {},
  addTempo() {},
  addNoteBend() {},
  addBend() {},
  finishTrack() {},
  addTickShift() {},
};

/** Bars in play order with absolute ticks, and every tempo change at its tick. */
export function playOrder(score: alphaTab.model.Score): { bars: PlayedBar[]; tempos: TempoChange[] } {
  const generator = new alphaTab.midi.MidiFileGenerator(score, null, noMidi);
  generator.generate();
  const bars: PlayedBar[] = [];
  const tempos: TempoChange[] = [];
  for (const mb of generator.tickLookup.masterBars) {
    bars.push({ index: mb.masterBar.index, startTick: mb.start, endTick: mb.end });
    for (const t of mb.tempoChanges) tempos.push({ tick: t.tick, bpm: t.tempo });
  }
  return { bars, tempos };
}

/** Start and end time (ms) of every bar as played. */
export function scoreTimeline(score: alphaTab.model.Score): TimedBar[] {
  const { bars, tempos } = playOrder(score);
  return buildTimeline(bars, tempos, score.tempo);
}

/** Tuning (MIDI pitches, string 1 = highest first) and capo of a track's first staff; null if it has no strings. */
export function staffTuning(score: alphaTab.model.Score, trackIndex: number): { pitches: number[]; capo: number } | null {
  const staff = score.tracks[trackIndex]?.staves[0];
  if (!staff || !staff.isStringed) return null;
  return { pitches: [...staff.tuning], capo: staff.capo };
}
