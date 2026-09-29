// socket.js - JSON websocket helper with reconnect and optional endpoints.
import { OPTIONAL_SOCKET_RETRY_LIMIT } from "./shared.js";

export class SocketManager {
  constructor(host) {
    this.host = host;
    this.sockets = {};
    this.failures = {};
    this.gaveUp = {};
  }
  canRetry(path, options) {
    if (!options || !options.optional) return true;
    if ((this.failures[path] || 0) <= OPTIONAL_SOCKET_RETRY_LIMIT) return true;
    if (!this.gaveUp[path]) {
      this.gaveUp[path] = true;
      console.warn(`[BeatmapPreview] optional endpoint ${path} unavailable, giving up`);
    }
    return false;
  }
  open(path, onMessage, filters, options) {
    if (this.sockets[path]) return;
    const url = `ws://${this.host}${path}?l=${encodeURIComponent(window.COUNTER_PATH || "")}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.failures[path] = (this.failures[path] || 0) + 1;
      if (this.canRetry(path, options)) setTimeout(() => this.open(path, onMessage, filters, options), 1000);
      return;
    }
    this.sockets[path] = ws;
    ws.onopen = () => {
      this.failures[path] = 0;
      if (filters) ws.send(`applyFilters:${JSON.stringify(filters)}`);
      if (options && typeof options.onOpen === "function") options.onOpen();
    };
    ws.onclose = () => {
      delete this.sockets[path];
      this.failures[path] = (this.failures[path] || 0) + 1;
      if (this.canRetry(path, options)) setTimeout(() => this.open(path, onMessage, filters, options), 1000);
    };
    ws.onerror = () => {
      console.warn("[BeatmapPreview] websocket error:", path);
    };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && typeof data === "object" && "error" in data) return;
        onMessage(data);
      } catch (err) {
        console.error("[BeatmapPreview]", err);
      }
    };
  }
  send(path, text) {
    const ws = this.sockets[path];
    if (ws && ws.readyState === 1) {
      ws.send(text);
      return true;
    }
    return false;
  }
}
