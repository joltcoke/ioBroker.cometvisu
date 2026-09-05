"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var webSocket_exports = {};
__export(webSocket_exports, {
  classifyWebSocket: () => classifyWebSocket
});
module.exports = __toCommonJS(webSocket_exports);
function classifyWebSocket(native) {
  const socketio = (native == null ? void 0 : native.socketio) || "";
  if (socketio === "none") {
    return { kind: "none" };
  }
  if (socketio.startsWith("system.adapter.")) {
    return {
      kind: "external",
      transport: socketio.startsWith("system.adapter.ws.") ? "ws" : "socket.io",
      instance: socketio
    };
  }
  return { kind: "integrated", transport: (native == null ? void 0 : native.usePureWebSockets) ? "ws" : "socket.io" };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  classifyWebSocket
});
//# sourceMappingURL=webSocket.js.map
