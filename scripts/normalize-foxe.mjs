// Make the packaged .foxe byte-reproducible.
//
// create-foxglove-extension zips every *file* with a fixed modification date
// (2021-02-03, the Foxglove birthday) specifically so .foxe files hash the same
// across builds. But it adds files with jszip's `createFolders: true`, and jszip
// stamps the parent directory entries it auto-creates with `new Date()` rather
// than the date passed alongside. The result is that `dist/` carries the build
// wall-clock time, so two builds of identical sources produce different SHA-256
// sums -- which matters because https://github.com/foxglove/extension-registry
// pins an exact sha256sum per release.
//
// This rewrites the DOS date/time fields of every entry, in both the local file
// headers and the central directory, to that same fixed date. It patches those
// four bytes per header in place and never touches a compressed stream, so the
// archive contents are bit-identical to what `foxglove-extension package` wrote.
//
// Upstream fix would be for create-foxglove-extension to create parent folder
// entries itself with MOD_DATE instead of relying on `createFolders`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Must match MOD_DATE in create-foxglove-extension/src/package.ts, which jszip
// encodes into the DOS fields using UTC.
const MOD_DATE = new Date("2021-02-03");

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Encode a date into the DOS date and time words used by the zip format. */
function toDosDateTime(date) {
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const day =
    ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

/** Locate the End Of Central Directory record, scanning back past any comment. */
function findEocd(buf) {
  const maxComment = 0xffff;
  const earliest = Math.max(0, buf.length - maxComment - 22);
  for (let offset = buf.length - 22; offset >= earliest; offset--) {
    if (buf.readUInt32LE(offset) === SIG_EOCD) {
      return offset;
    }
  }
  throw new Error("Not a zip file: no end-of-central-directory record found");
}

function normalize(path) {
  const buf = readFileSync(path);
  const { time, day } = toDosDateTime(MOD_DATE);

  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);

  if (entryCount === 0xffff || cursor === 0xffffffff) {
    throw new Error("Zip64 archives are not supported");
  }

  for (let index = 0; index < entryCount; index++) {
    if (buf.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error(`Corrupt central directory: bad signature at entry ${index}`);
    }

    // Central directory header: time at +12, date at +14, local offset at +42.
    buf.writeUInt16LE(time, cursor + 12);
    buf.writeUInt16LE(day, cursor + 14);

    const localOffset = buf.readUInt32LE(cursor + 42);
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`Corrupt archive: bad local header signature at entry ${index}`);
    }
    // Local file header: time at +10, date at +12.
    buf.writeUInt16LE(time, localOffset + 10);
    buf.writeUInt16LE(day, localOffset + 12);

    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  writeFileSync(path, buf);
  console.log(`Normalized ${entryCount} zip entries in ${path}`);
}

/** Mirrors getPackageDirname() in create-foxglove-extension. */
function defaultFoxePath() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), { encoding: "utf8" }));
  const publisher = pkg.publisher.toLowerCase().replace(/\W+/g, "");
  return join(root, `${publisher}.${pkg.name.toLowerCase()}-${pkg.version}.foxe`);
}

normalize(process.argv[2] ?? defaultFoxePath());
