// Manual memory repro for MCAP framing. Not part of CI — process RSS is far too
// environment-dependent to gate on. Run it when you want to see the difference for yourself:
//
//   node --expose-gc scripts/measure-framing-memory.mjs
//
// It frames one fixed record set repeatedly, first streaming each chunk straight out and
// discarding it (what the clip and mirror writes do now), then accumulating the whole MCAP in
// memory the way the old path did. Watch `rss`: the streaming numbers stay flat, the buffering
// numbers ratchet upwards and never come back. Nothing is leaking in either case — `heapUsed`
// and `arrayBuffers` are flat throughout — the giant transient allocations simply fragment the
// allocator, and the OS does not take the pages back.

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "dvr-memory-"));

const outfile = join(tmp, "buildMcap.mjs");
await build({
  entryPoints: [join(root, "src/buildMcap.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  outfile,
});
const { frameInto, MemoryWritable } = await import(pathToFileURL(outfile).href);

const TARGET_BYTES = 117 * 1024 * 1024;
const MESSAGE_BYTES = 64 * 1024;
const ITERATIONS = 30;

const encoder = new TextEncoder();
const filler = "x".repeat(MESSAGE_BYTES);
const records = [];
for (let i = 0; records.length * MESSAGE_BYTES < TARGET_BYTES; i++) {
  const logTime = 1_700_000_000_000_000_000n + BigInt(i) * 1_000_000n;
  records.push({
    topic: i % 2 === 0 ? "/camera/front" : "/camera/rear",
    logTime,
    publishTime: logTime,
    arrivalNanos: logTime, // ignored by framing; present so the record shape matches
    data: encoder.encode(JSON.stringify({ i, filler })),
  });
}
const schemas = new Map(
  ["/camera/front", "/camera/rear"].map((topic) => [
    topic,
    { name: topic, encoding: "jsonschema", data: encoder.encode("{}") },
  ]),
);

/** Forwards each chunk onward and forgets it, like a file being appended to. */
function discardingWritable() {
  let position = 0;
  return {
    write: async (chunk) => {
      position += chunk.byteLength;
    },
    position: () => BigInt(position),
  };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

function report(label, iteration) {
  const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
  console.log(
    `${label} ${String(iteration).padStart(2)}  ` +
      `rss ${mb(rss).padStart(7)}   heapUsed ${mb(heapUsed).padStart(7)}   ` +
      `arrayBuffers ${mb(arrayBuffers).padStart(7)}`,
  );
}

async function run(label, makeWritable) {
  for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
    await frameInto(makeWritable(), records, schemas);
    global.gc?.();
    if (iteration === 1 || iteration % 5 === 0) {
      report(label, iteration);
    }
  }
}

console.log(
  `framing ${records.length} records (~${mb(records.length * MESSAGE_BYTES)} of payload) ` +
    `${ITERATIONS}x per path\n`,
);
if (global.gc == undefined) {
  console.log("(run with --expose-gc for stable numbers)\n");
}

console.log("streaming each chunk straight out (current behaviour):");
await run("stream ", discardingWritable);

console.log("\naccumulating the whole MCAP in memory (the old behaviour):");
await run("buffer ", () => new MemoryWritable());
