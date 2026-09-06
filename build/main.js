"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var utils = __toESM(require("@iobroker/adapter-core"));
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var import_releases = require("./lib/releases");
var import_webSocket = require("./lib/webSocket");
const FORMER_OWN_SERVER_SETTINGS = [
  "port",
  "ip",
  "findNextPort",
  "secure",
  "certPublic",
  "certPrivate",
  "certChained",
  "auth",
  "defaultUser",
  "defaultUserPassword",
  "ttl",
  "ownServer"
];
class Cometvisu extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: "cometvisu" });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    await this.setState("info.connection", { val: false, ack: true });
    await this.dropFormerServerSettings();
    const dataDir = utils.getAbsoluteInstanceDataDir(this);
    await this.pruneCustomBuilds(dataDir);
    let htmlRoot;
    let servedTag = null;
    try {
      const selection = await this.resolveVersion();
      if (selection.kind === "custom") {
        htmlRoot = await this.prepareCustomBuild(dataDir, selection.file);
        this.log.info(`uploaded CometVisu build prepared in ${htmlRoot}`);
      } else {
        const result = await (0, import_releases.ensureRelease)(dataDir, selection.tag, this.log);
        htmlRoot = result.htmlRoot;
        servedTag = result.tag;
        this.log.info(`CometVisu ${result.tag} prepared in ${htmlRoot}`);
      }
    } catch (e) {
      this.log.error(`could not prepare the CometVisu build: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const dropped = (0, import_releases.pruneReleaseBuilds)(dataDir, servedTag);
    if (dropped.length) {
      this.log.info(`removed unpacked release(s) no longer in use: ${dropped.join(", ")}`);
    }
    fs.mkdirSync(path.join(dataDir, "resource"), { recursive: true });
    if (!this.config.webInstance) {
      this.log.error(
        "the visualisation is served by the web adapter - please install it and select its instance in the settings"
      );
      return;
    }
    if (!await this.checkWebSocket()) {
      return;
    }
    await this.setState("info.connection", { val: true, ack: true });
    this.log.info(`the CometVisu build is ready, ${this.config.webInstance} serves it under /cometvisu`);
  }
  /**
   * Remove the settings of the web server this adapter used to run itself. They stay in an
   * instance that was created while they still existed, where they are misleading - the admin
   * keeps showing a port that nothing listens on, and an encrypted password no code reads.
   *
   * The object is written back as a whole instead of extending it: whether extendObject deletes a
   * single attribute is not something this could rely on. Changing our own configuration makes the
   * controller restart the instance once; there is nothing left to do on the next start, so this
   * just carries on afterwards.
   */
  async dropFormerServerSettings() {
    const id = `system.adapter.${this.namespace}`;
    let obj;
    try {
      obj = await this.getForeignObjectAsync(id);
    } catch (e) {
      this.log.warn(`cannot read ${id}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const native = obj == null ? void 0 : obj.native;
    if (!native) {
      return;
    }
    const found = FORMER_OWN_SERVER_SETTINGS.filter((key) => key in native);
    if (!found.length) {
      return;
    }
    for (const key of found) {
      delete native[key];
    }
    try {
      await this.setForeignObjectAsync(id, obj);
      this.log.info(`removed settings of the former own web server: ${found.join(", ")}`);
    } catch (e) {
      this.log.warn(`cannot clean up ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /**
   * Report which socket CometVisu will use, and say so clearly when the web instance offers none.
   * The extension reads the same configuration in the process of the web adapter, but a CometVisu
   * problem is looked for in this log, so the message belongs here as well.
   */
  async checkWebSocket() {
    const instance = `system.adapter.${this.config.webInstance}`;
    let obj;
    try {
      obj = await this.getForeignObjectAsync(instance);
    } catch (e) {
      this.log.warn(`cannot read ${instance}: ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
    if (!obj) {
      this.log.error(
        `${instance} does not exist - the visualisation is served by the web adapter, please install it and select its instance in the settings`
      );
      return false;
    }
    const setup = (0, import_webSocket.classifyWebSocket)(obj.native);
    if (setup.kind === "none") {
      this.log.error(
        `${this.config.webInstance} serves no socket ("none"), so CometVisu cannot reach ioBroker - configure a socket in that web instance`
      );
      return false;
    }
    const where = setup.kind === "external" ? setup.instance : this.config.webInstance;
    this.log.info(`CometVisu will talk ${setup.transport} to ${where}`);
    return true;
  }
  /**
   * What the configured version points at. The admin stores a prefixed entry of the version list,
   * but a bare value can still show up from an older configuration. Such a value is an uploaded
   * archive if a file by that name exists, and a release tag otherwise.
   */
  async resolveVersion() {
    const value = (this.config.version || "").replace(/^\/+/, "");
    const selection = (0, import_releases.resolveVersionSelection)(value, this.config.buildUpload);
    if (selection.kind === "custom" || !selection.tag) {
      return selection;
    }
    if (value.startsWith(import_releases.OFFICIAL_FILE_PREFIX)) {
      return selection;
    }
    for (const candidate of [value, `${import_releases.CUSTOM_FILE_PREFIX}${value}`]) {
      try {
        if (await this.fileExistsAsync(`${this.namespace}.files`, candidate)) {
          return { kind: "custom", file: candidate };
        }
      } catch {
      }
    }
    return selection;
  }
  /**
   * Return the directory to serve for an uploaded ("custom") build. Every upload has its own
   * directory, so switching back to a build that was unpacked before costs no unpacking at all.
   * Unpacking only happens when that directory is missing, or when the archive was uploaded again
   * under the same name - which the size and time of the stored file reveal.
   *
   * @param dataDir the instance data directory
   * @param file name of the uploaded archive to serve
   */
  async prepareCustomBuild(dataDir, file) {
    if (!file) {
      throw new Error("no CometVisu build selected - please upload one in the adapter settings");
    }
    const source = await this.uploadSource(file);
    const current = (0, import_releases.readCustomBuild)(dataDir, file);
    if (current && this.matchesUpload(current.source, source)) {
      this.log.debug(`uploaded CometVisu build "${file}" is already unpacked`);
      return current.htmlRoot;
    }
    const tmp = path.join(dataDir, "upload.tar.gz");
    try {
      const stored = await this.readFileAsync(`${this.namespace}.files`, file);
      const buffer = Buffer.isBuffer(stored.file) ? stored.file : Buffer.from(stored.file, "binary");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmp, buffer);
      const result = await (0, import_releases.unpackUploadedTarball)(tmp, dataDir, this.log, source);
      return result.htmlRoot;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  /**
   * Size and modification time of an uploaded archive, used to notice that it was replaced by a
   * new upload of the same name without reading the whole archive.
   *
   * @param file name of the uploaded archive
   */
  async uploadSource(file) {
    var _a;
    try {
      const entries = await this.readDirAsync(`${this.namespace}.files`, "/");
      const entry = entries.find((e) => e.file === file);
      if (entry) {
        return { file, size: (_a = entry.stats) == null ? void 0 : _a.size, modifiedAt: entry.modifiedAt };
      }
    } catch {
    }
    return { file };
  }
  /**
   * Whether an unpacked build was made from exactly the archive that is stored now. A marker
   * without size and time comes from an older adapter version, so that build is unpacked again.
   *
   * @param unpacked the source the build was unpacked from
   * @param stored the archive currently in the file storage
   */
  matchesUpload(unpacked, stored) {
    if (!unpacked || unpacked.file !== stored.file) {
      return false;
    }
    if (unpacked.size === void 0 || unpacked.modifiedAt === void 0) {
      return false;
    }
    return unpacked.size === stored.size && unpacked.modifiedAt === stored.modifiedAt;
  }
  /**
   * Drop the builds whose archive is no longer in the file storage, plus the single directory all
   * uploads shared before every upload got its own one.
   *
   * @param dataDir the instance data directory
   */
  async pruneCustomBuilds(dataDir) {
    var _a;
    if ((0, import_releases.removeLegacyCustomBuild)(dataDir)) {
      this.log.info("removed the CometVisu build directory of the previous adapter version");
    }
    let uploads;
    try {
      const entries = await this.readDirAsync(`${this.namespace}.files`, "/");
      uploads = entries.filter((entry) => !entry.isDir).map((entry) => entry.file);
    } catch {
      return;
    }
    for (const build of (0, import_releases.listCustomBuilds)(dataDir)) {
      if (build.file === null || !uploads.includes(build.file)) {
        fs.rmSync(build.dir, { recursive: true, force: true });
        this.log.info(`removed unpacked build of deleted archive "${(_a = build.file) != null ? _a : build.dir}"`);
      }
    }
  }
  /**
   * The admin component asks to remove the build of an archive it just deleted, so the unpacked
   * files go away right there instead of only at the next start.
   *
   * @param obj the admin message
   */
  onMessage(obj) {
    var _a;
    if (!obj || typeof obj !== "object" || obj.command !== "deleteCustomBuild") {
      return;
    }
    const file = (_a = obj.message) == null ? void 0 : _a.file;
    let removed = false;
    if (file) {
      removed = (0, import_releases.removeCustomBuild)(utils.getAbsoluteInstanceDataDir(this), file);
      if (removed) {
        this.log.info(`removed unpacked build of deleted archive "${file}"`);
      }
    }
    if (obj.callback) {
      this.sendTo(obj.from, obj.command, { removed }, obj.callback);
    }
  }
  onUnload(callback) {
    try {
      void this.setState("info.connection", { val: false, ack: true });
      callback();
    } catch (e) {
      this.log.error(`error during unload: ${e instanceof Error ? e.message : String(e)}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Cometvisu(options);
} else {
  (() => new Cometvisu())();
}
//# sourceMappingURL=main.js.map
