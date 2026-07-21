import { McapWriter, IWritable } from "@mcap/core";

/**
 * One buffered message, already JSON-encoded by the worker on arrival. The worker
 * owns encoding so the main thread never does it; this module owns MCAP framing.
 */
export type DvrRecord = {
  topic: string;
  logTime: bigint;
  publishTime: bigint;
  data: Uint8Array;
};

/** A per-topic schema record to register before its channel. */
export type DvrSchema = {
  name: string;
  encoding: string;
  data: Uint8Array;
};

/** In-memory {@link IWritable} that accumulates chunks and concatenates on demand. */
class MemoryWritable implements IWritable {
  #chunks: Uint8Array[] = [];
  #size = 0;

  public position(): bigint {
    return BigInt(this.#size);
  }

  public async write(buffer: Uint8Array): Promise<void> {
    // McapWriter may reuse the same backing buffer across writes, so copy.
    this.#chunks.push(buffer.slice());
    this.#size += buffer.byteLength;
  }

  public toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.#size);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

/**
 * Build a fully indexed MCAP (chunks + chunk index + message index + statistics +
 * summary offsets) from buffered records. Indexed output means the Foxglove app
 * uses the indexed reader (no unindexed-size cap) and topics carry schemas.
 *
 * A panel only sees schema *names*, not definitions, so `schemaByTopic` carries a
 * JSON Schema synthesized from the observed message shapes (see `inferSchema.ts`).
 * Messages are `json`-encoded; schemas are `jsonschema`-encoded.
 */
export async function buildMcap(
  records: readonly DvrRecord[],
  schemaByTopic: ReadonlyMap<string, DvrSchema>,
): Promise<Uint8Array> {
  const writable = new MemoryWritable();
  const writer = new McapWriter({
    writable,
    useChunks: true,
    useChunkIndex: true,
    useMessageIndex: true,
    useStatistics: true,
    useSummaryOffsets: true,
  });

  await writer.start({ profile: "", library: "diy-dvr" });

  const channelByTopic = new Map<string, { id: number; sequence: number }>();
  for (const record of records) {
    let channel = channelByTopic.get(record.topic);
    if (!channel) {
      const schema = schemaByTopic.get(record.topic);
      let schemaId = 0;
      if (schema) {
        schemaId = await writer.registerSchema({
          name: schema.name,
          encoding: schema.encoding,
          data: schema.data,
        });
      }
      const id = await writer.registerChannel({
        schemaId,
        topic: record.topic,
        messageEncoding: "json",
        metadata: new Map(),
      });
      channel = { id, sequence: 0 };
      channelByTopic.set(record.topic, channel);
    }
    await writer.addMessage({
      channelId: channel.id,
      sequence: channel.sequence++,
      logTime: record.logTime,
      publishTime: record.publishTime,
      data: record.data,
    });
  }

  await writer.end();
  return writable.toUint8Array();
}
