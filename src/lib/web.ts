// Web extension for iobroker.web: serves the CometVisu build through the web adapter, so its login,
// session and socket protect and supply the visualisation. This module is loaded by iobroker.web
// (common.webExtension in io-package.json) and runs inside that adapter's process - the download and
// unpacking of a build stays in our own adapter process, this one only serves what is on disk.

import * as utils from '@iobroker/adapter-core';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { findHtmlRoot, readCustomBuild, resolveVersionSelection } from './releases';
import { type WebNative, classifyWebSocket } from './webSocket';

/** The part of our instance object this extension needs. */
interface InstanceSettings {
    _id: string;
    native: {
        version?: string;
        buildUpload?: string;
    };
}

/** Settings iobroker.web hands to every extension. */
interface WebSettings {
    secure?: boolean;
    port?: number;
    language?: string;
    defaultUser?: string;
    auth?: boolean;
}

/**
 * Exported twice on purpose, because iobroker.web changed how it picks the class up: up to 7.0.8 it
 * only unwraps a default export, from 7.0.9 on it also looks for `module[<file name>]`. The class
 * name therefore has to stay `web`, and the default export below keeps the older loader working.
 */
export class web {
    private readonly log: ioBroker.Logger;
    /** namespace of our own instance, e.g. "cometvisu.0" */
    private readonly namespace: string;
    private readonly native: InstanceSettings['native'];
    /** path the visualisation is mounted under */
    private readonly mountPath: string;
    /** serves the current build, null while there is none to serve */
    private handler: express.RequestHandler | null = null;
    /** directory the current handler serves, null while there is nothing to serve */
    private servedRoot: string | null = null;
    /** set once unload() ran, so a late request does not resurrect the handler */
    private unloaded = false;
    /** whether the web instance offers a socket at all */
    private hasSocket = false;
    /** port of an external socket adapter, null while the socket is on the port of the web adapter */
    private socketPort: number | null = null;
    /** whether an external socket is reached over TLS */
    private socketSecure = false;

    /**
     * Mounts the visualisation into the web adapter's express app.
     *
     * @param _server the web adapter's http(s) server, unused
     * @param _webSettings settings of the web instance, unused
     * @param adapter the web adapter, used for logging
     * @param instanceSettings our own instance object
     * @param app express app of the web adapter
     */
    public constructor(
        _server: unknown,
        _webSettings: WebSettings,
        adapter: ioBroker.Adapter,
        instanceSettings: InstanceSettings,
        app: express.Express,
    ) {
        this.log = adapter.log;
        this.namespace = instanceSettings._id.substring('system.adapter.'.length);
        this.native = instanceSettings.native || {};
        // several instances must not fight over the same path
        this.mountPath = this.namespace.endsWith('.0') ? '/cometvisu' : `/${this.namespace}`;

        this.resolveSocket(adapter);
        this.refresh();
        // one stable mount point; what is behind it follows the configuration and the disk
        app.use(this.mountPath, (req, res, next) => {
            if (this.unloaded) {
                next();
                return;
            }
            // Without the trailing slash the browser would resolve every relative asset against the
            // parent path, so send it to the directory form first.
            if (req.originalUrl === this.mountPath) {
                res.redirect(301, `${this.mountPath}/`);
                return;
            }
            // Tell CometVisu which backend to connect to. The request reaches us through the web
            // adapter, so its origin - and with it its socket, login and session - is the right
            // one, unless the socket lives in another adapter on its own port. Which protocol that
            // socket speaks does not have to be told: CometVisu loads the matching client library
            // from /socket.io.js of that very server. This is only a default, the visu config wins.
            res.setHeader('X-CometVisu-Backend-Name', 'iobroker');
            if (this.hasSocket) {
                res.setHeader('X-CometVisu-Backend-IoBroker-Url', this.socketUrl(req));
            }

            // The adapter unpacks the build in its own process, which may still be running - or may
            // have replaced the build under the same name. Re-resolving whenever nothing is served
            // (or what was served disappeared) picks that up without restarting the web adapter.
            if (!this.servedRoot || !fs.existsSync(this.servedRoot)) {
                this.refresh();
            }
            if (!this.handler) {
                res.status(503).send('No CometVisu build has been prepared yet - please check the adapter instance.');
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
    public objectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        if (id !== `system.adapter.${this.namespace}` || !obj) {
            return;
        }
        const native = (obj as unknown as InstanceSettings).native || {};
        if (native.version === this.native.version && native.buildUpload === this.native.buildUpload) {
            return;
        }
        this.native.version = native.version;
        this.native.buildUpload = native.buildUpload;
        this.log.info(`CometVisu version changed to "${native.version || ''}"`);
        this.refresh();
    }

    /** Called by the web adapter when our instance goes away. */
    public unload(): void {
        // the mount stays in place, but stops handling anything
        this.unloaded = true;
        this.handler = null;
        this.servedRoot = null;
    }

    /**
     * Directory of the build the instance is configured to serve, or null when it is not unpacked
     * (yet). Uses the same resolution as the adapter itself.
     */
    private resolveHtmlRoot(): string | null {
        const dataDir = utils.getAbsoluteInstanceDataDir(this.namespace);
        const selection = resolveVersionSelection(this.native.version || '', this.native.buildUpload);

        if (selection.kind === 'custom') {
            return readCustomBuild(dataDir, selection.file)?.htmlRoot ?? null;
        }

        // A release is unpacked into a directory named after its tag. An empty tag comes from older
        // configurations ("latest"), where only the adapter knows which tag that resolved to - it
        // keeps just the release being served, so the single remaining directory is the right one.
        const releaseDir = selection.tag
            ? path.join(dataDir, 'cometvisu', selection.tag)
            : this.findSingleReleaseDir(dataDir);

        return releaseDir && fs.existsSync(path.join(releaseDir, '.complete')) ? findHtmlRoot(releaseDir) : null;
    }

    /**
     * The one unpacked release directory, ignoring the uploaded builds.
     *
     * @param dataDir the instance data directory
     */
    private findSingleReleaseDir(dataDir: string): string | null {
        const root = path.join(dataDir, 'cometvisu');
        if (!fs.existsSync(root)) {
            return null;
        }
        const dirs = fs
            .readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name !== 'custom' && !entry.name.startsWith('__'))
            .map(entry => path.join(root, entry.name));
        return dirs.length === 1 ? dirs[0] : null;
    }

    /**
     * Work out which socket CometVisu has to connect to. An external socket adapter runs on its own
     * port, which is only known after reading its instance object - until that answer arrives, and
     * if it never does, the origin of the request is used.
     *
     * @param adapter the web adapter we run in
     */
    private resolveSocket(adapter: ioBroker.Adapter): void {
        const setup = classifyWebSocket(adapter.config as WebNative);
        if (setup.kind === 'none') {
            this.log.error(
                `${adapter.namespace} serves no socket ("none"), so CometVisu cannot reach ioBroker - ` +
                    'configure a socket in that web instance',
            );
            return;
        }
        this.hasSocket = true;
        if (setup.kind !== 'external') {
            return;
        }
        adapter.getForeignObjectAsync(setup.instance).then(
            obj => {
                const native = obj?.native as { port?: number; secure?: boolean } | undefined;
                if (!native?.port) {
                    this.log.warn(`cannot read the port of ${setup.instance}, using the port of the web adapter`);
                    return;
                }
                this.socketPort = native.port;
                this.socketSecure = !!native.secure;
                this.log.info(`CometVisu connects to ${setup.instance} on port ${native.port} (${setup.transport})`);
            },
            (e: Error) => this.log.warn(`cannot read ${setup.instance}: ${e.message}`),
        );
    }

    /**
     * The websocket URL to hand to CometVisu for this request.
     *
     * @param req the request being answered
     */
    private socketUrl(req: express.Request): string {
        if (this.socketPort === null) {
            return `${req.secure ? 'wss' : 'ws'}://${req.headers.host}/`;
        }
        // same host as the request, but the port of the adapter that serves the socket
        const host = (req.headers.host || '').replace(/:\d+$/, '');
        return `${this.socketSecure ? 'wss' : 'ws'}://${host}:${this.socketPort}/`;
    }

    /** Points the handler at the configured build, or drops it when there is none. */
    private refresh(): void {
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

        const router = express.Router();
        // same overlay as the adapter's own web server: a user provided "resource" folder wins over
        // the one shipped with the build
        const overlayDir = path.join(utils.getAbsoluteInstanceDataDir(this.namespace), 'resource');
        if (fs.existsSync(overlayDir)) {
            router.use('/resource', express.static(overlayDir));
        }
        router.use(express.static(htmlRoot));

        this.handler = router;
        this.servedRoot = htmlRoot;
        this.log.info(`CometVisu (${this.namespace}) serves ${htmlRoot}`);
    }
}

export default web;
