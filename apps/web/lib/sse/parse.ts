import { SseEvent } from "@busmitra/contracts";

/**
 * An incremental text/event-stream parser (the WHATWG rules the stream actually uses): frames
 * end at a blank line, `id:` sets the resumable id, lines starting `:` are comments (the
 * gateway's heartbeat). Frames that fail the contract are dropped, never guessed at.
 */
export interface ParsedFrame {
  id: string | null;
  event: SseEvent;
}

export class SseParser {
  private buf = "";

  /** Feed a chunk; returns complete frames and whether any bytes (incl. heartbeats) arrived. */
  push(chunk: string): { frames: ParsedFrame[]; comments: number } {
    this.buf += chunk.replace(/\r\n?/g, "\n");
    const frames: ParsedFrame[] = [];
    let comments = 0;
    let cut: number;
    while ((cut = this.buf.indexOf("\n\n")) !== -1) {
      const block = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut + 2);
      let id: string | null = null;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) comments++;
        else if (line.startsWith("id:")) id = line.slice(3).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      try {
        const parsed = SseEvent.safeParse(JSON.parse(data.join("\n")));
        if (parsed.success) frames.push({ id, event: parsed.data });
      } catch {
        // malformed JSON: skip the frame, keep the stream
      }
    }
    return { frames, comments };
  }
}
