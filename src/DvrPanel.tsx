import { PanelExtensionContext, Topic } from "@foxglove/extension";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { MCAP_WORKER_SOURCE } from "./generatedWorkerSource";

type WorkerStat = { messageCount: number; channels: number };

function downloadMcap(buffer: ArrayBuffer): void {
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `diy-dvr-${Date.now()}.mcap`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

function DvrPanel({ context }: { context: PanelExtensionContext }): JSX.Element {
  const [topics, setTopics] = useState<readonly Topic[]>([]);
  const [forwarded, setForwarded] = useState(0);
  const [stat, setStat] = useState<WorkerStat>({ messageCount: 0, channels: 0 });
  const [workerReady, setWorkerReady] = useState(false);
  const workerRef = useRef<Worker | undefined>(undefined);

  // Spin up the worker once from a Blob URL (source bundled as a string).
  useEffect(() => {
    const blob = new Blob([MCAP_WORKER_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { type: "stat"; messageCount: number; channels: number }
        | { type: "saved"; buffer: ArrayBuffer; messageCount: number; channels: number }
        | { type: "error"; message: string };
      if (data.type === "stat") {
        setStat({ messageCount: data.messageCount, channels: data.channels });
      } else if (data.type === "saved") {
        setStat({ messageCount: data.messageCount, channels: data.channels });
        downloadMcap(data.buffer);
      } else if (data.type === "error") {
        console.error("[diy-dvr] worker save failed", data.message);
      }
    };
    worker.onerror = (err) => {
      console.error("[diy-dvr] worker error", err);
    };
    workerRef.current = worker;
    setWorkerReady(true);
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
      workerRef.current = undefined;
    };
  }, []);

  // Forward every message from every subscribed topic to the worker.
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      if (renderState.topics) {
        setTopics(renderState.topics);
      }
      const frame = renderState.currentFrame;
      const worker = workerRef.current;
      if (frame && frame.length > 0 && worker) {
        for (const msg of frame) {
          worker.postMessage({
            type: "msg",
            topic: msg.topic,
            schemaName: msg.schemaName,
            receiveTime: msg.receiveTime,
            publishTime: msg.publishTime,
            message: msg.message,
          });
        }
        setForwarded((n) => n + frame.length);
      }
      done();
    };
    context.watch("topics");
    context.watch("currentFrame");
  }, [context]);

  // (Re)subscribe to all advertised topics whenever the set changes.
  useEffect(() => {
    if (topics.length > 0) {
      context.subscribe(topics.map((topic) => ({ topic: topic.name })));
    }
  }, [context, topics]);

  const onSave = useCallback(() => {
    workerRef.current?.postMessage({ type: "save" });
  }, []);

  const onReset = useCallback(() => {
    workerRef.current?.postMessage({ type: "reset" });
    setForwarded(0);
    setStat({ messageCount: 0, channels: 0 });
  }, []);

  return (
    <div style={{ padding: "1rem", fontFamily: "sans-serif", lineHeight: 1.5 }}>
      <h2 style={{ margin: "0 0 0.5rem" }}>DIY DVR</h2>
      <p style={{ margin: "0 0 1rem", opacity: 0.7 }}>
        Forwards every message on every topic to a Web Worker, which encodes them to MCAP. Click
        Save to dump the buffer to a file.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button onClick={onSave} disabled={!workerReady} style={{ padding: "0.5rem 1rem" }}>
          Save MCAP
        </button>
        <button onClick={onReset} disabled={!workerReady} style={{ padding: "0.5rem 1rem" }}>
          Reset buffer
        </button>
      </div>

      <table style={{ borderSpacing: "0.5rem 0.25rem" }}>
        <tbody>
          <tr>
            <td style={{ opacity: 0.7 }}>Worker</td>
            <td>{workerReady ? "ready" : "starting…"}</td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Topics subscribed</td>
            <td>{topics.length}</td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Messages forwarded</td>
            <td>{forwarded}</td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Buffered in worker</td>
            <td>
              {stat.messageCount} msgs / {stat.channels} channels
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function initDvrPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<DvrPanel context={context} />);
  return () => {
    root.unmount();
  };
}
