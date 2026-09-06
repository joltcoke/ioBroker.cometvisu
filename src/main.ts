/*
 * Created with @iobroker/create-adapter v3.1.5
 */

import * as utils from '@iobroker/adapter-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    CUSTOM_FILE_PREFIX,
    type CustomBuildSource,
    OFFICIAL_FILE_PREFIX,
    type VersionSelection,
    ensureRelease,
    listCustomBuilds,
    pruneReleaseBuilds,
    readCustomBuild,
    removeCustomBuild,
    removeLegacyCustomBuild,
    resolveVersionSelection,
    unpackUploadedTarball,
} from './lib/releases';
import { type WebNative, classifyWebSocket } from './lib/webSocket';

// The visualisation is served by iobroker.web through the extension in lib/web.ts, which runs in
// that adapter's process. This adapter only keeps the selected build ready on disk.

// Settings of the web server this adapter used to run itself. They were dropped from io-package.json,
// but an instance created before that still carries them: the upgrade only adds missing defaults
// (extendNative() in @iobroker/js-controller-cli), it never removes what is gone.
const FORMER_OWN_SERVER_SETTINGS = [
    'port',
    'ip',
    'findNextPort',
    'secure',
    'certPublic',
    'certPrivate',
    'certChained',
    'auth',
    'defaultUser',
    'defaultUserPassword',
    'ttl',
    'ownServer',
];

class Cometvisu extends utils.Adapter {
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'cometvisu' });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', { val: false, ack: true });
        await this.dropFormerServerSettings();

        // 1) make sure the selected CometVisu build is available locally
        const dataDir = utils.getAbsoluteInstanceDataDir(this);
        await this.pruneCustomBuilds(dataDir);
        let htmlRoot: string;
        // tag of the release being prepared, null while an uploaded build is used
        let servedTag: string | null = null;
        try {
            const selection = await this.resolveVersion();
            if (selection.kind === 'custom') {
                // the build the user uploaded through the admin
                htmlRoot = await this.prepareCustomBuild(dataDir, selection.file);
                this.log.info(`uploaded CometVisu build prepared in ${htmlRoot}`);
            } else {
                const result = await ensureRelease(dataDir, selection.tag, this.log);
                htmlRoot = result.htmlRoot;
                servedTag = result.tag;
                this.log.info(`CometVisu ${result.tag} prepared in ${htmlRoot}`);
            }
        } catch (e) {
            this.log.error(`could not prepare the CometVisu build: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }

        // A release is cached as its unpacked directory, so only the one in use is kept - this
        // runs after the build was prepared, both because "latest" only resolves to a tag in there
        // and so a failed preparation leaves the existing cache alone.
        const dropped = pruneReleaseBuilds(dataDir, servedTag);
        if (dropped.length) {
            this.log.info(`removed unpacked release(s) no longer in use: ${dropped.join(', ')}`);
        }

        // A user provided "resource" folder next to the version folders acts as an overlay for
        // /resource/*, which the extension puts in front of the build's own resource folder. It is
        // created here so there is a place to drop files into even when it was never used.
        fs.mkdirSync(path.join(dataDir, 'resource'), { recursive: true });

        if (!this.config.webInstance) {
            this.log.error(
                'the visualisation is served by the web adapter - please install it and select its ' +
                    'instance in the settings',
            );
            return;
        }
        if (!(await this.checkWebSocket())) {
            return;
        }
        await this.setState('info.connection', { val: true, ack: true });
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
    private async dropFormerServerSettings(): Promise<void> {
        const id = `system.adapter.${this.namespace}`;
        let obj: ioBroker.Object | null | undefined;
        try {
            obj = await this.getForeignObjectAsync(id);
        } catch (e) {
            this.log.warn(`cannot read ${id}: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        const native = obj?.native as Record<string, unknown> | undefined;
        if (!native) {
            return;
        }

        const found = FORMER_OWN_SERVER_SETTINGS.filter(key => key in native);
        if (!found.length) {
            return;
        }
        for (const key of found) {
            delete native[key];
        }

        try {
            await this.setForeignObjectAsync(id, obj!);
            this.log.info(`removed settings of the former own web server: ${found.join(', ')}`);
        } catch (e) {
            this.log.warn(`cannot clean up ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Report which socket CometVisu will use, and say so clearly when the web instance offers none.
     * The extension reads the same configuration in the process of the web adapter, but a CometVisu
     * problem is looked for in this log, so the message belongs here as well.
     */
    private async checkWebSocket(): Promise<boolean> {
        const instance = `system.adapter.${this.config.webInstance}`;
        let obj: ioBroker.Object | null | undefined;
        try {
            obj = await this.getForeignObjectAsync(instance);
        } catch (e) {
            this.log.warn(`cannot read ${instance}: ${e instanceof Error ? e.message : String(e)}`);
            return true;
        }
        if (!obj) {
            this.log.error(
                `${instance} does not exist - the visualisation is served by the web adapter, please ` +
                    'install it and select its instance in the settings',
            );
            return false;
        }

        const setup = classifyWebSocket(obj.native as WebNative);
        if (setup.kind === 'none') {
            this.log.error(
                `${this.config.webInstance} serves no socket ("none"), so CometVisu cannot reach ioBroker - ` +
                    'configure a socket in that web instance',
            );
            return false;
        }
        const where = setup.kind === 'external' ? setup.instance : this.config.webInstance;
        this.log.info(`CometVisu will talk ${setup.transport} to ${where}`);
        return true;
    }

    /**
     * What the configured version points at. The admin stores a prefixed entry of the version list,
     * but a bare value can still show up from an older configuration. Such a value is an uploaded
     * archive if a file by that name exists, and a release tag otherwise.
     */
    private async resolveVersion(): Promise<VersionSelection> {
        const value = (this.config.version || '').replace(/^\/+/, '');
        const selection = resolveVersionSelection(value, this.config.buildUpload);
        if (selection.kind === 'custom' || !selection.tag) {
            return selection;
        }
        if (value.startsWith(OFFICIAL_FILE_PREFIX)) {
            return selection;
        }
        // a bare value: an upload if such a file exists, otherwise a release tag
        for (const candidate of [value, `${CUSTOM_FILE_PREFIX}${value}`]) {
            try {
                if (await this.fileExistsAsync(`${this.namespace}.files`, candidate)) {
                    return { kind: 'custom', file: candidate };
                }
            } catch {
                // no file storage yet - treat the value as a release tag
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
    private async prepareCustomBuild(dataDir: string, file: string): Promise<string> {
        if (!file) {
            throw new Error('no CometVisu build selected - please upload one in the adapter settings');
        }
        const source = await this.uploadSource(file);
        const current = readCustomBuild(dataDir, file);
        if (current && this.matchesUpload(current.source, source)) {
            this.log.debug(`uploaded CometVisu build "${file}" is already unpacked`);
            return current.htmlRoot;
        }

        const tmp = path.join(dataDir, 'upload.tar.gz');
        try {
            const stored = await this.readFileAsync(`${this.namespace}.files`, file);
            const buffer = Buffer.isBuffer(stored.file) ? stored.file : Buffer.from(stored.file, 'binary');

            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(tmp, buffer);
            const result = await unpackUploadedTarball(tmp, dataDir, this.log, source);
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
    private async uploadSource(file: string): Promise<CustomBuildSource> {
        try {
            const entries = await this.readDirAsync(`${this.namespace}.files`, '/');
            const entry = entries.find(e => e.file === file);
            if (entry) {
                return { file, size: entry.stats?.size, modifiedAt: entry.modifiedAt };
            }
        } catch {
            // no file storage yet - the read of the archive itself will report the real problem
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
    private matchesUpload(unpacked: CustomBuildSource | null, stored: CustomBuildSource): boolean {
        if (!unpacked || unpacked.file !== stored.file) {
            return false;
        }
        if (unpacked.size === undefined || unpacked.modifiedAt === undefined) {
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
    private async pruneCustomBuilds(dataDir: string): Promise<void> {
        if (removeLegacyCustomBuild(dataDir)) {
            this.log.info('removed the CometVisu build directory of the previous adapter version');
        }
        let uploads: string[];
        try {
            const entries = await this.readDirAsync(`${this.namespace}.files`, '/');
            uploads = entries.filter(entry => !entry.isDir).map(entry => entry.file);
        } catch {
            // without a file storage there is nothing to compare against, so keep what is there
            return;
        }
        for (const build of listCustomBuilds(dataDir)) {
            if (build.file === null || !uploads.includes(build.file)) {
                fs.rmSync(build.dir, { recursive: true, force: true });
                this.log.info(`removed unpacked build of deleted archive "${build.file ?? build.dir}"`);
            }
        }
    }

    /**
     * The admin component asks to remove the build of an archive it just deleted, so the unpacked
     * files go away right there instead of only at the next start.
     *
     * @param obj the admin message
     */
    private onMessage(obj: ioBroker.Message): void {
        if (!obj || typeof obj !== 'object' || obj.command !== 'deleteCustomBuild') {
            return;
        }
        const file = (obj.message as { file?: string } | undefined)?.file;
        let removed = false;
        if (file) {
            removed = removeCustomBuild(utils.getAbsoluteInstanceDataDir(this), file);
            if (removed) {
                this.log.info(`removed unpacked build of deleted archive "${file}"`);
            }
        }
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, { removed }, obj.callback);
        }
    }

    private onUnload(callback: () => void): void {
        try {
            void this.setState('info.connection', { val: false, ack: true });
            callback();
        } catch (e) {
            this.log.error(`error during unload: ${e instanceof Error ? e.message : String(e)}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Cometvisu(options);
} else {
    // otherwise start the instance directly
    (() => new Cometvisu())();
}
