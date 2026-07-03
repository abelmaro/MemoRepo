import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeStdioResponse, StdioMessageParser } from "../src/cli/stdioTransport.js";

test("stdio parser accepts newline-delimited JSON messages", () => {
  const parser = new StdioMessageParser();
  const messages = parser.push(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', "utf8"));

  assert.deepEqual(messages, [
    {
      format: "line",
      raw: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
    }
  ]);
});

test("stdio parser accepts Content-Length framed messages split across chunks", () => {
  const parser = new StdioMessageParser();
  const body = '{"jsonrpc":"2.0","id":2,"method":"initialize"}';
  const framed = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;

  assert.deepEqual(parser.push(Buffer.from(framed.slice(0, 12), "utf8")), []);
  assert.deepEqual(parser.push(Buffer.from(framed.slice(12), "utf8")), [{ format: "framed", raw: body }]);
});

test("stdio response encoder preserves the inbound transport format", () => {
  const response = { jsonrpc: "2.0", id: 1, result: { ok: true } };
  assert.equal(encodeStdioResponse(response, "line"), `${JSON.stringify(response)}\n`);

  const framed = encodeStdioResponse(response, "framed");
  const body = JSON.stringify(response);
  assert.equal(framed, `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
});
