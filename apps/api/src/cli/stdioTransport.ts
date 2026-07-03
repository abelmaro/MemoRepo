export type StdioMessageFormat = "framed" | "line";

export interface StdioMessage {
  format: StdioMessageFormat;
  raw: string;
}

export class StdioMessageParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): StdioMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: StdioMessage[] = [];

    while (this.buffer.length > 0) {
      this.dropLeadingLineBreaks();

      if (this.startsWithContentLengthHeader()) {
        const parsed = this.readFramedMessage();
        if (!parsed) {
          break;
        }
        messages.push(parsed);
        continue;
      }

      const newlineIndex = this.buffer.indexOf(0x0a);
      if (newlineIndex < 0) {
        break;
      }

      const raw = this.buffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (raw.trim().length > 0) {
        messages.push({ format: "line", raw });
      }
    }

    return messages;
  }

  private readFramedMessage(): StdioMessage | null {
    const headerEnd = this.findHeaderEnd();
    if (!headerEnd) {
      return null;
    }

    const header = this.buffer.subarray(0, headerEnd.index).toString("ascii");
    const length = this.contentLength(header);
    const bodyStart = headerEnd.index + headerEnd.separatorLength;
    const bodyEnd = bodyStart + length;
    if (this.buffer.length < bodyEnd) {
      return null;
    }

    const raw = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    this.buffer = this.buffer.subarray(bodyEnd);
    return { format: "framed", raw };
  }

  private contentLength(header: string): number {
    const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
    if (!match) {
      throw new Error("Missing Content-Length header");
    }

    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("Invalid Content-Length header");
    }
    return length;
  }

  private findHeaderEnd(): { index: number; separatorLength: number } | null {
    const crlfIndex = this.buffer.indexOf("\r\n\r\n");
    const lfIndex = this.buffer.indexOf("\n\n");

    if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)) {
      return { index: crlfIndex, separatorLength: 4 };
    }
    if (lfIndex >= 0) {
      return { index: lfIndex, separatorLength: 2 };
    }
    return null;
  }

  private startsWithContentLengthHeader(): boolean {
    return this.buffer.subarray(0, "Content-Length:".length).toString("ascii").toLowerCase() === "content-length:";
  }

  private dropLeadingLineBreaks(): void {
    while (this.buffer[0] === 0x0a || this.buffer[0] === 0x0d) {
      this.buffer = this.buffer.subarray(1);
    }
  }
}

export function encodeStdioResponse(response: unknown, format: StdioMessageFormat): string {
  const json = JSON.stringify(response);
  if (format === "framed") {
    return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  }
  return `${json}\n`;
}
