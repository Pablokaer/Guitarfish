import { describe, expect, it } from "vitest";
import { songsterrQuery } from "../src/match";
import type { Track } from "../src/types";
import { cleanChannel, cleanVideoTitle, songOf, splitVideoTitle } from "../src/youtube";

const video = (title: string, artist: string, service: Track["service"] = "youtube"): Track => ({
  title,
  artist,
  album: "",
  isPlaying: true,
  source: "os",
  player: "YouTube (Chrome, macOS)",
  service,
});
const song = (title: string, artist: string, service?: Track["service"]) => {
  const t = songOf(video(title, artist, service));
  return { artist: t.artist, title: t.title };
};

describe("songOf: YouTube videos", () => {
  it.each([
    ["Oasis - Wonderwall (Official Video)", "OasisVEVO", "Oasis", "Wonderwall"],
    ["Metallica: Nothing Else Matters (Official Music Video)", "Metallica", "Metallica", "Metallica: Nothing Else Matters"],
    ["Nirvana - Smells Like Teen Spirit (Official Music Video) [4K]", "NirvanaVEVO", "Nirvana", "Smells Like Teen Spirit"],
    ["Arctic Monkeys – Do I Wanna Know? | Official Video", "ArcticMonkeysVEVO", "Arctic Monkeys", "Do I Wanna Know?"],
    ["Wonderwall", "Oasis - Topic", "Oasis", "Wonderwall"],
    ["Legião Urbana - Tempo Perdido (Clipe Oficial)", "Legião Urbana Oficial", "Legião Urbana", "Tempo Perdido"],
    ["Hotel California (Live) [HD]", "Eagles", "Eagles", "Hotel California (Live)"],
    ['Radiohead "Creep"', "Radiohead", "Radiohead", "Creep"],
    ["Queen — Bohemian Rhapsody (Official Video Remastered)", "Queen Official", "Queen", "Bohemian Rhapsody"],
    ["Blackbird (Remastered 2009) #beatles #guitar", "The Beatles", "The Beatles", "Blackbird"],
    ["Sweet Child O' Mine Official Music Video", "Guns N' Roses", "Guns N' Roses", "Sweet Child O' Mine"],
    ["【MV】 Lemon", "米津玄師", "米津玄師", "Lemon"],
  ])("%s / %s", (title, channel, artist, name) => {
    expect(song(title, channel)).toEqual({ artist, title: name });
  });

  it("prefers the artist the title names over the channel (a label or a cover channel)", () => {
    expect(song("Pink Floyd - Wish You Were Here", "Warner Records")).toEqual({ artist: "Pink Floyd", title: "Wish You Were Here" });
  });

  it("drops the album and keeps the rest of the track", () => {
    const t = songOf({ ...video("Oasis - Wonderwall", "OasisVEVO"), album: "x", positionMs: 1000, durationMs: 258000 });
    expect(t).toMatchObject({ album: null, positionMs: 1000, durationMs: 258000, isPlaying: true });
  });

  it("gives Songsterr a clean query", () => {
    expect(songsterrQuery(songOf(video("Oasis - Wonderwall (Official Video)", "OasisVEVO")))).toBe("Oasis Wonderwall");
  });

  it("reads browser media the YouTube way", () => {
    expect(song("Oasis - Wonderwall (Official Video)", "OasisVEVO", "browser")).toEqual({ artist: "Oasis", title: "Wonderwall" });
  });

  it("only tidies the artist of YouTube Music, whose titles are songs already", () => {
    expect(song("Don't Look Back in Anger - Remastered", "Oasis - Topic", "youtube-music")).toEqual({ artist: "Oasis", title: "Don't Look Back in Anger - Remastered" });
  });

  it("leaves Spotify and unknown players alone", () => {
    const t = video("Song - Remastered 2011", "Band", "spotify");
    expect(songOf(t)).toBe(t);
    const old = { ...video("Song - Live", "Band"), service: undefined };
    expect(songOf(old)).toBe(old);
  });
});

describe("helpers", () => {
  it("cleans channel names", () => {
    expect(cleanChannel("OasisVEVO")).toBe("Oasis");
    expect(cleanChannel("Taylor Swift VEVO")).toBe("Taylor Swift");
    expect(cleanChannel("Nirvana - Topic")).toBe("Nirvana");
    expect(cleanChannel("Metallica TV")).toBe("Metallica");
    expect(cleanChannel("Oficial")).toBe("Oficial"); // never cleaned down to nothing
    expect(cleanChannel("  Muse ")).toBe("Muse");
  });

  it("keeps brackets that are part of the song's name", () => {
    expect(cleanVideoTitle("Song (Acoustic)")).toBe("Song (Acoustic)");
    expect(cleanVideoTitle("Song (feat. X) [Official Audio]")).toBe("Song (feat. X)");
    expect(cleanVideoTitle("Song (Letra/Lyrics)")).toBe("Song");
  });

  it("splits only when both sides have something", () => {
    expect(splitVideoTitle("Song")).toBeNull();
    expect(splitVideoTitle("Artist - Song - Live")).toEqual({ artist: "Artist", title: "Song - Live" });
    expect(splitVideoTitle("Up-Tempo Song")).toBeNull();
  });
});
