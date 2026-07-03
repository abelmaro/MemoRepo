#!/usr/bin/env node
import { encodeStdioResponse, StdioMessageParser, type StdioMessageFormat } from "./stdioTransport.js";
import { createServices } from "../services/appServices.js";

const args = process.argv.slice(2);
const spaceIndex = args.indexOf("--space");
const tokenIndex = args.indexOf("--token");
const spaceSlug = spaceIndex >= 0 ? args[spaceIndex + 1] : undefined;
const token = tokenIndex >= 0 ? args[tokenIndex + 1] : process.env.MEMOREPO_MCP_TOKEN;

if (!spaceSlug) {
  console.error("memorepo-mcp requires --space <slug>");
  process.exit(1);
}

if (!token) {
  console.error("memorepo-mcp requires MEMOREPO_MCP_TOKEN or --token");
  process.exit(1);
}

const services = createServices();
const parser = new StdioMessageParser();

process.stdin.on("data", (chunk: Buffer) => {
  let messages;
  try {
    messages = parser.push(chunk);
  } catch (error) {
    writeError("line", null, error);
    return;
  }

  for (const message of messages) {
    let request;
    try {
      request = JSON.parse(message.raw);
    } catch (error) {
      writeError(message.format, null, error);
      continue;
    }

    void services.mcp
      .handleJsonRpc(spaceSlug, token, request)
      .then((response) => {
        if (response) {
          process.stdout.write(encodeStdioResponse(response, message.format));
        }
      })
      .catch((error: unknown) => writeError(message.format, request?.id ?? null, error));
  }
});

process.stdin.resume();

function writeError(format: StdioMessageFormat, id: string | number | null, error: unknown): void {
  process.stdout.write(
    encodeStdioResponse(
      {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
      },
      format
    )
  );
}
