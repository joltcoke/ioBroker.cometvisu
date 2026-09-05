"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var web_exports = {};
__export(web_exports, {
  default: () => web_default,
  web: () => web
});
module.exports = __toCommonJS(web_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_express = __toESM(require("express"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var import_releases = require("./releases");
var import_webSocket = require("./webSocket");
class web {
  log;
  /** namespace of our own instance, e.g. "cometvisu.0" */
  namespace;
  native;
  /** path the visualisation is mounted under */
  mountPath;
  /** serves the current build, null while there is none to serve */
  handler = null;
  /** directory the current handler serves, null while there is nothing to serve */
  servedRoot = null;
  /** set once unload() ran, so a late request does not resurrect the handler */
  unloaded = false;
  /** whether the web instance offers a socket at all */
  hasSocket = false;
  /** port of an external socket adapter, null while the socket is on the port of the web adapter */
  socketPort = null;
  /** whether an external socket is reached over TLS */
  socketSecure = false;
  /**
   * Mounts the visualisation into the web adapter's express app.
   *
   * @param _server the web adapter's http(s) server, unused
   * @param _webSettings settings of the web instance, unused
   * @param adapter the web adapter, used for logging
   * @param instanceSettings our own instance object
   * @param app express app of the web adapter
   */
  constructor(_server, _webSettings, adapter, instanceSettings, app) {
    this.log = adapter.log;
    this.namespace = instanceSettings._id.substring("system.adapter.".length);
    this.native = instanceSettings.native || {};
    this.mountPath = this.namespace.endsWith(".0") ? "/cometvisu" : `/${this.namespace}`;
    this.resolveSocket(adapter);
    this.refresh();
    app.use(this.mountPath, (req, res, next) => {
      if (this.unloaded) {
        next();
        return;
      }
      if (req.originalUrl === this.mountPath) {
        res.redirect(301, `${this.mountPath}/`);
        return;
      }
      res.setHeader("X-CometVisu-Backend-Name", "iobroker");
      if (this.hasSocket) {
        res.setHeader("X-CometVisu-Backend-IoBroker-Url", this.socketUrl(req));
      }
      if (!this.servedRoot || !fs.existsSync(this.servedRoot)) {
        this.refresh();
      }
      if (!this.handler) {
        res.status(503).send("No CometVisu build has been prepared yet - please check the adapter instance.");
        return;
      }
      this.handler(req, res, next);
    });
    this.log.info(`CometVisu is served by the web adapter under ${this.mountPath}/`);
  }
  // No welcomePage() on purpose: iobroker.web appends what the extensions return there *after* it
  // has de-duplicated the list it built from common.localLinks, so an entry here would simply show
  // up a second time. common.localLinks covers both the welcome screen and the link in the admin.
  /**
   * Pick up a version that was selected in the admin without restarting the web adapter.
   *
   * @param id id of the changed object
   * @param obj the changed object
   */
  objectChange(id, obj) {
    if (id !== `system.adapter.${this.namespace}` || !obj) {
      return;
    }
    const native = obj.native || {};
    if (native.version === this.native.version && native.buildUpload === this.native.buildUpload) {
      return;
    }
    this.native.version = native.version;
    this.native.buildUpload = native.buildUpload;
    this.log.info(`CometVisu version changed to "${native.version || ""}"`);
    this.refresh();
  }
  /** Called by the web adapter when our instance goes away. */
  unload() {
    this.unloaded = true;
    this.handler = null;
    this.servedRoot = null;
  }
  /**
   * Directory of the build the instance is configured to serve, or null when it is not unpacked
   * (yet). Uses the same resolution as the adapter itself.
   */
  resolveHtmlRoot() {
    var _a, _b;
    const dataDir = utils.getAbsoluteInstanceDataDir(this.namespace);
    const selection = (0, import_releases.resolveVersionSelection)(this.native.version || "", this.native.buildUpload);
    if (selection.kind === "custom") {
      return (_b = (_a = (0, import_releases.readCustomBuild)(dataDir, selection.file)) == null ? void 0 : _a.htmlRoot) != null ? _b : null;
    }
    const releaseDir = selection.tag ? path.join(dataDir, "cometvisu", selection.tag) : this.findSingleReleaseDir(dataDir);
    return releaseDir && fs.existsSync(path.join(releaseDir, ".complete")) ? (0, import_releases.findHtmlRoot)(releaseDir) : null;
  }
  /**
   * The one unpacked release directory, ignoring the uploaded builds.
   *
   * @param dataDir the instance data directory
   */
  findSingleReleaseDir(dataDir) {
    const root = path.join(dataDir, "cometvisu");
    if (!fs.existsSync(root)) {
      return null;
    }
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "custom" && !entry.name.startsWith("__")).map((entry) => path.join(root, entry.name));
    return dirs.length === 1 ? dirs[0] : null;
  }
  /**
   * Work out which socket CometVisu has to connect to. An external socket adapter runs on its own
   * port, which is only known after reading its instance object - until that answer arrives, and
   * if it never does, the origin of the request is used.
   *
   * @param adapter the web adapter we run in
   */
  resolveSocket(adapter) {
    const setup = (0, import_webSocket.classifyWebSocket)(adapter.config);
    if (setup.kind === "none") {
      this.log.error(
        `${adapter.namespace} serves no socket ("none"), so CometVisu cannot reach ioBroker - configure a socket in that web instance`
      );
      return;
    }
    this.hasSocket = true;
    if (setup.kind !== "external") {
      return;
    }
    adapter.getForeignObjectAsync(setup.instance).then(
      (obj) => {
        const native = obj == null ? void 0 : obj.native;
        if (!(native == null ? void 0 : native.port)) {
          this.log.warn(`cannot read the port of ${setup.instance}, using the port of the web adapter`);
          return;
        }
        this.socketPort = native.port;
        this.socketSecure = !!native.secure;
        this.log.info(`CometVisu connects to ${setup.instance} on port ${native.port} (${setup.transport})`);
      },
      (e) => this.log.warn(`cannot read ${setup.instance}: ${e.message}`)
    );
  }
  /**
   * The websocket URL to hand to CometVisu for this request.
   *
   * @param req the request being answered
   */
  socketUrl(req) {
    if (this.socketPort === null) {
      return `${req.secure ? "wss" : "ws"}://${req.headers.host}/`;
    }
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    return `${this.socketSecure ? "wss" : "ws"}://${host}:${this.socketPort}/`;
  }
  /** Points the handler at the configured build, or drops it when there is none. */
  refresh() {
    const htmlRoot = this.resolveHtmlRoot();
    if (!htmlRoot) {
      if (this.servedRoot) {
        this.log.warn(`the CometVisu build served for ${this.namespace} disappeared`);
      }
      this.servedRoot = null;
      this.handler = null;
      return;
    }
    if (htmlRoot === this.servedRoot && this.handler) {
      return;
    }
    const router = import_express.default.Router();
    const overlayDir = path.join(utils.getAbsoluteInstanceDataDir(this.namespace), "resource");
    if (fs.existsSync(overlayDir)) {
      router.use("/resource", import_express.default.static(overlayDir));
    }
    router.use(import_express.default.static(htmlRoot));
    this.handler = router;
    this.servedRoot = htmlRoot;
    this.log.info(`CometVisu (${this.namespace}) serves ${htmlRoot}`);
  }
}
var web_default = web;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  web
});
//# sourceMappingURL=web.js.map
