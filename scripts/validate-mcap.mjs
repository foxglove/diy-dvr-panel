// Offline validation of the writer path (buildMcap + schemaRegistry + inferSchema)
// without a browser. Mirrors the worker: resolve a real schema by name, base64
// byte arrays, json-encode, frame to indexed MCAP. Follow with:
//   mcap doctor <out> && mcap list schemas <out> && mcap info <out>

import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "dvr-validate-"));

async function bundleForNode(rel) {
  const out = join(tmp, rel.replace(/[^\w]/g, "_") + ".mjs");
  await build({
    entryPoints: [join(root, rel)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    outfile: out,
  });
  return import(pathToFileURL(out).href);
}

const { buildMcap } = await bundleForNode("src/buildMcap.ts");
const { resolveSchema } = await bundleForNode("src/schemaRegistry.ts");

const encoder = new TextEncoder();

function toBase64(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return Buffer.from(binary, "binary").toString("base64");
}
function jsonReplacer(_k, v) {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return toBase64(v); // only unsigned bytes -> base64
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v);
  return v;
}

// Two ROS2 topics: a numeric-array message and a byte-array (image) message.
const topics = [
  {
    topic: "/scan",
    schemaName: "sensor_msgs/msg/LaserScan",
    make: (i) => ({
      header: { stamp: { sec: 1700 + i, nanosec: 0 }, frame_id: "laser" },
      angle_min: -1.5,
      angle_max: 1.5,
      angle_increment: 0.01,
      ranges: new Float32Array([1.1, 2.2, 3.3]),
      intensities: new Float32Array([10, 20, 30]),
    }),
  },
  {
    topic: "/camera/compressed",
    schemaName: "sensor_msgs/msg/CompressedImage",
    make: (i) => ({
      header: { stamp: { sec: 1700 + i, nanosec: 0 }, frame_id: "cam" },
      format: "jpeg",
      data: new Uint8Array([255, 216, 255, 224, i & 0xff, 1, 2, 3]),
    }),
  },
  {
    topic: "/map",
    schemaName: "nav_msgs/msg/OccupancyGrid",
    make: () => ({
      header: { stamp: { sec: 1700, nanosec: 0 }, frame_id: "map" },
      info: { resolution: 0.05, width: 2, height: 2, origin: {} },
      // int8[]: -1 = unknown, 0 = free, 100 = occupied
      data: new Int8Array([-1, 0, 100, -1]),
    }),
  },
];

const records = [];
const schemas = new Map();
for (const t of topics) {
  schemas.set(t.topic, {
    name: t.schemaName,
    encoding: "jsonschema",
    data: encoder.encode(JSON.stringify(resolveSchema(t.schemaName) ?? {})),
  });
}
for (let i = 0; i < 50; i++) {
  for (const t of topics) {
    const logTime = 1_700_000_000_000_000_000n + BigInt(i) * 1_000_000n;
    records.push({
      topic: t.topic,
      logTime,
      publishTime: logTime,
      data: encoder.encode(JSON.stringify(t.make(i), jsonReplacer)),
    });
  }
}

const bytes = await buildMcap(records, schemas);
const outPath = process.argv[2] ?? join(tmp, "sample.mcap");
writeFileSync(outPath, bytes);

// Sanity: the CompressedImage schema must type `data` as base64, and a message's
// data must be a base64 string (not a number array).
const imgData = resolveSchema("sensor_msgs/msg/CompressedImage")?.properties?.data;
const mapData = resolveSchema("nav_msgs/msg/OccupancyGrid")?.properties?.data;
console.log(`wrote ${outPath} (${bytes.length} bytes, ${records.length} messages)`);
console.log("CompressedImage.data (uint8[]) schema:", JSON.stringify(imgData), "=> expect base64");
console.log("OccupancyGrid.data (int8[]) schema:", JSON.stringify(mapData), "=> expect array");
const mapMsg = JSON.parse(new TextDecoder().decode(records.find((r) => r.topic === "/map").data));
console.log("OccupancyGrid.data encoded as:", Array.isArray(mapMsg.data) ? `array ${JSON.stringify(mapMsg.data)}` : typeof mapMsg.data);
