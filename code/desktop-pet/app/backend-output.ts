import type { Writable } from 'node:stream';

/** Desktop EOF may precede backend cleanup; never write cleanup events to a dead pipe. */
export function createBackendOutput(stream: Writable, onDisconnect: () => void) {
  let open = true;
  const disconnect = () => {
    if (!open) return;
    open = false; onDisconnect();
  };
  // Keep the error listener through shutdown so a queued write cannot become an uncaught EPIPE.
  stream.on('error', disconnect);
  stream.on('close', disconnect);
  return {
    get open() { return open; },
    close() { open = false; },
    send(message: unknown) {
      if (!open) return;
      if (stream.destroyed || stream.writableEnded) { disconnect(); return; }
      try { stream.write(JSON.stringify(message) + '\n'); }
      catch { disconnect(); }
    },
  };
}
