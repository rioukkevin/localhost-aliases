/**
 * What the hero says. One project, told honestly: the port you type today, the name you
 * type instead, and the loopback address that actually carries it.
 */

export type Tone = "ink" | "muted" | "faint";
export type Segment = { text: string; tone: Tone };

/** The port is the readable half here — it is the thing being replaced. */
export const FROM: Segment[] = [
  { text: "localhost", tone: "muted" },
  { text: ":", tone: "faint" },
  { text: "3000", tone: "ink" },
];

export const TO: Segment[] = [
  { text: "shop", tone: "ink" },
  { text: ".test", tone: "faint" },
];

export const segmentText = (segments: Segment[]): string => segments.map((s) => s.text).join("");

export const FROM_LENGTH = segmentText(FROM).length;
export const TO_LENGTH = segmentText(TO).length;

/** The row in the rack. These are the four real values the product moves around. */
export const ALIAS = {
  host: "shop",
  tld: ".test",
  ip: "127.0.0.2",
  port: "3000",
  target: "127.0.0.1",
  /** The forwarder always binds :80 on the alias IP; that is what the cable carries. */
  wire: "tcp :80",
} as const;
