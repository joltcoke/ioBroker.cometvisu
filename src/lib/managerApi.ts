// REST API the CometVisu manager talks to. The contract is the one CometVisu ships as
// source/rest/openapi.yaml ("CometVisu Manager backend 1.0.0"); the PHP backend in that repository
// is generated from the same file. Only the operations the editor and the manager actually need are
// implemented here - the chart endpoints of the PHP backend do not apply, timeseries come from the
// ioBroker history adapters.
//
// The router is mounted below the visualisation, so every request carries the login and the session
// of the web instance that serves it.

import express, { type NextFunction, type Request, type Response, Router } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
    BACKUP_FOLDER,
    BACKUP_ON_CHANGE,
    type ManagerRoots,
    TRASH_FOLDER,
    backupName,
    listNames,
    resolvePath,
    writeTarget,
} from './managerFs';

/** One entry of a directory listing, as the manager expects it. */
export interface FsEntry {
    /** name of the file or folder, without any path */
    name: string;
    /** whether it is a folder or a file */
    type: 'DIR' | 'FILE';
    /** relative path of the folder it lies in */
    parentFolder: string;
    /** whether a folder has any entries */
    hasChildren: boolean;
    /** whether its content can be read */
    readable: boolean;
    /** whether it can be written */
    writeable: boolean;
    /** whether it comes from a read-only mount instead of the config directory */
    mounted: boolean;
    /** whether this is the trash folder itself */
    trash: boolean;
    /** whether it lies inside the trash folder */
    inTrash: boolean;
    /** CRC32 of the content, so the manager notices a file that changed underneath it */
    hash?: number;
}

/** One entry of a data provider list, as the editor consumes it. */
export interface DataProviderEntry {
    /** what is inserted into the config */
    value: string;
    /** what is shown in the completion list */
    label: string;
}

/** What the router needs from the extension it is mounted in. */
export interface ManagerContext {
    /** the directories of this instance, resolved per request because the build can change */
    roots(): ManagerRoots;
    /** whether write operations are allowed */
    writable(): boolean;
    /** version of this adapter */
    version: string;
    /** the addresses the editor offers for completion */
    addresses(): Promise<DataProviderEntry[]>;
    /** logger of the web adapter we run in */
    log: ioBroker.Logger;
}

/**
 * CRC32 of a file's content, undefined when it cannot be read.
 *
 * @param file absolute path of the file
 */
function contentHash(file: string): number | undefined {
    try {
        return zlib.crc32(fs.readFileSync(file));
    } catch {
        return undefined;
    }
}

/**
 * Describe one entry of a directory for the manager.
 *
 * @param roots directories of this instance
 * @param parent relative path of the directory the entry lies in
 * @param name name of the entry
 * @param writable whether write operations are allowed at all
 */
function describe(roots: ManagerRoots, parent: string, name: string, writable: boolean): FsEntry | null {
    const relative = parent ? `${parent}/${name}` : name;
    const resolved = resolvePath(roots, relative);
    if (!resolved) {
        return null;
    }

    let stat: fs.Stats;
    try {
        stat = fs.statSync(resolved.absolute);
    } catch {
        return null;
    }
    const isDir = stat.isDirectory();

    return {
        name,
        type: isDir ? 'DIR' : 'FILE',
        parentFolder: parent,
        hasChildren: isDir && listNames(roots, relative).length > 0,
        readable: true,
        writeable: writable && resolved.writeable,
        mounted: resolved.mounted,
        trash: relative === TRASH_FOLDER,
        inTrash: resolved.inTrash,
        hash: isDir ? undefined : contentHash(resolved.absolute),
    };
}

/**
 * Bitmask the manager uses to describe one entity: exists = 1, readable = 2, writeable = 4.
 *
 * @param roots directories of this instance
 * @param relative relative path to look at
 * @param writable whether write operations are allowed at all
 */
function environmentState(roots: ManagerRoots, relative: string, writable: boolean): number {
    const resolved = resolvePath(roots, relative);
    if (!resolved || !fs.existsSync(resolved.absolute)) {
        return 0;
    }
    let state = 1;
    try {
        fs.accessSync(resolved.absolute, fs.constants.R_OK);
        state |= 2;
    } catch {
        // stays unreadable
    }
    if (writable && resolved.writeable) {
        state |= 4;
    }
    return state;
}

/**
 * Write a file and make sure what landed on disk is what was meant. The manager may send the CRC32
 * of the content it transmits; a mismatch means the transport damaged it, and nothing is written.
 * The new content goes to a neighbouring file first and is only moved into place once it reads back
 * correctly, so a failure never leaves a half written config behind.
 *
 * @param target absolute path to write
 * @param content content to write
 * @param expected hash the client announced, "ignore" or absent when it does not care
 */
function writeContent(target: string, content: string, expected: unknown): void {
    const hash = zlib.crc32(content);
    if (typeof expected === 'string' && expected !== '' && expected !== 'ignore' && expected !== String(hash)) {
        throw Object.assign(new Error('data has been corrupted during transport'), { status: 405 });
    }

    const temporary = `${target}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, content);
        if (zlib.crc32(fs.readFileSync(temporary)) !== hash) {
            throw Object.assign(new Error('hash mismatch on written content'), { status: 405 });
        }
        fs.renameSync(temporary, target);
    } finally {
        if (fs.existsSync(temporary)) {
            fs.rmSync(temporary, { force: true });
        }
    }
}

/**
 * Keep a copy of a config before it is overwritten, as the reference backend does for
 * visu_config*.xml. A build only file is copied too - it is about to be shadowed by an edit.
 *
 * @param roots directories of this instance
 * @param relative relative path of the file being written
 * @param current absolute path of the version that is about to be replaced
 */
function backup(roots: ManagerRoots, relative: string, current: string): void {
    const name = relative.split('/').pop() ?? '';
    if (!BACKUP_ON_CHANGE.test(name) || !fs.existsSync(current)) {
        return;
    }
    const folder = writeTarget(roots, BACKUP_FOLDER);
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(current, path.join(folder, backupName(name, new Date())));
}

/**
 * Remove an entry. Unless it is forced or already in the trash it is moved there, so a wrong click
 * stays recoverable.
 *
 * @param roots directories of this instance
 * @param relative relative path of the entry
 * @param target absolute path in the overlay
 * @param force whether to delete instead of moving to the trash
 * @param inTrash whether the entry already lies in the trash
 */
function remove(roots: ManagerRoots, relative: string, target: string, force: boolean, inTrash: boolean): void {
    if (force || inTrash) {
        if (!force && fs.statSync(target).isDirectory() && fs.readdirSync(target).length > 0) {
            throw Object.assign(new Error('folder not empty'), { status: 406 });
        }
        fs.rmSync(target, { recursive: true, force: true });
        return;
    }

    const trashed = writeTarget(roots, `${TRASH_FOLDER}/${relative}`);
    fs.mkdirSync(path.dirname(trashed), { recursive: true });
    // an entry of the same name that was thrown away earlier makes room for this one
    fs.rmSync(trashed, { recursive: true, force: true });
    fs.renameSync(target, trashed);
}

/**
 * The manager API for one instance.
 *
 * @param ctx what the router needs from the extension
 */
export function createManagerRouter(ctx: ManagerContext): Router {
    const router = Router();

    /**
     * Refuse an operation that is not available yet or not allowed.
     *
     * @param res response to answer
     * @param reason what to tell the caller
     */
    const readOnly = (res: Response, reason: string): void => {
        res.status(403).json({ message: reason });
    };

    /**
     * Answer a failed write. The status the operation carried wins, everything else is a 405, which
     * is what the reference backend reports for a write that did not work out.
     *
     * @param res response to answer
     * @param e whatever was thrown
     */
    const failed = (res: Response, e: unknown): void => {
        const status = typeof (e as { status?: number })?.status === 'number' ? (e as { status: number }).status : 405;
        const message = e instanceof Error ? e.message : String(e);
        ctx.log.warn(`CometVisu manager: ${message}`);
        res.status(status).json({ message });
    };

    // CometVisu asks this before it enables the manager. It expects the shape of the PHP backend,
    // but nothing here has to pretend to be PHP: the version check compares numbers
    // (Application.js __constraintFails), so ">=0.0" always passes and PHP_VERSION_ID may be
    // absent entirely. "requiresAuth" stays false because CometVisu has nothing to add to the
    // requests - they go to the origin that serves the page and carry the session of the web
    // instance already.
    router.get(['/environment.php', '/environment'], (_req: Request, res: Response) => {
        res.json({
            SERVER_SOFTWARE: `ioBroker.cometvisu ${ctx.version}`,
            phpversion: 'none - served by the ioBroker adapter',
            required_php_version: '>=0.0',
            requiresAuth: false,
        });
    });

    router.get('/fs/check', (_req: Request, res: Response) => {
        const roots = ctx.roots();
        const writable = ctx.writable();
        res.json([
            { entity: 'config', state: environmentState(roots, '', writable) },
            { entity: 'backup', state: environmentState(roots, 'backup', writable) },
            { entity: 'trash', state: environmentState(roots, TRASH_FOLDER, writable) },
        ]);
    });

    router.get('/fs', (req: Request, res: Response) => {
        const roots = ctx.roots();
        const resolved = resolvePath(roots, req.query.path as string | undefined);
        if (!resolved) {
            readOnly(res, 'path is not allowed');
            return;
        }

        let stat: fs.Stats;
        try {
            stat = fs.statSync(resolved.absolute);
        } catch {
            res.status(404).json({ message: 'path not found' });
            return;
        }

        if (stat.isDirectory()) {
            const writable = ctx.writable();
            const entries = listNames(roots, resolved.relative)
                .map(name => describe(roots, resolved.relative, name, writable))
                .filter((entry): entry is FsEntry => entry !== null);
            res.json(entries);
            return;
        }

        if (req.query.download === 'true') {
            res.download(resolved.absolute, path.basename(resolved.absolute));
            return;
        }
        res.type('text/plain').send(fs.readFileSync(resolved.absolute, 'utf8'));
    });

    // Every write goes through here first, so a locked instance answers the same way everywhere.
    const guard = (req: Request, res: Response, next: NextFunction): void => {
        if (!ctx.writable()) {
            readOnly(res, 'editing is disabled - the web instance requires no login');
            return;
        }
        next();
    };

    // The manager sends the content as text, with the content type of the file being written.
    // A multipart upload - what the media file dialog uses - is refused rather than stored: parsing
    // it as text would write the envelope into the file and quietly corrupt it.
    const text = express.text({ type: () => true, limit: '16mb' });
    const body = (req: Request, res: Response, next: NextFunction): void => {
        if ((req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/')) {
            res.status(415).json({ message: 'uploading files is not supported yet' });
            return;
        }
        text(req, res, next);
    };

    router.post('/fs', guard, body, (req: Request, res: Response) => {
        const roots = ctx.roots();
        const resolved = resolvePath(roots, req.query.path as string | undefined);
        if (!resolved || resolved.mounted) {
            readOnly(res, 'path is not allowed');
            return;
        }
        const target = writeTarget(roots, resolved.relative);
        if (fs.existsSync(target)) {
            res.status(406).json({ message: 'file exists' });
            return;
        }

        try {
            if (req.query.type === 'dir') {
                fs.mkdirSync(target, { recursive: true });
            } else {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                writeContent(target, typeof req.body === 'string' ? req.body : '', req.query.hash);
            }
        } catch (e) {
            failed(res, e);
            return;
        }
        res.json({ message: 'created' });
    });

    router.put('/fs', guard, body, (req: Request, res: Response) => {
        const roots = ctx.roots();
        const resolved = resolvePath(roots, req.query.path as string | undefined);
        if (!resolved || resolved.mounted) {
            readOnly(res, 'path is not allowed');
            return;
        }
        // A file that is still served from the build does exist for the manager, and writing it
        // creates the overlay copy - that is what makes an edit survive a version change.
        if (!fs.existsSync(resolved.absolute)) {
            res.status(404).json({ message: 'file does not exist' });
            return;
        }

        const target = writeTarget(roots, resolved.relative);
        try {
            backup(roots, resolved.relative, resolved.absolute);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            writeContent(target, typeof req.body === 'string' ? req.body : '', req.query.hash);
        } catch (e) {
            failed(res, e);
            return;
        }
        res.json({ message: 'saved' });
    });

    router.delete('/fs', guard, (req: Request, res: Response) => {
        const roots = ctx.roots();
        const resolved = resolvePath(roots, req.query.path as string | undefined);
        if (!resolved || resolved.mounted || resolved.relative === '') {
            readOnly(res, 'path is not allowed');
            return;
        }
        const target = writeTarget(roots, resolved.relative);
        if (!fs.existsSync(target)) {
            // only present in the build - there is nothing of ours to remove
            res.status(404).json({ message: 'file not found' });
            return;
        }

        const force = req.query.force === 'true';
        try {
            remove(roots, resolved.relative, target, force, resolved.inTrash);
        } catch (e) {
            failed(res, e);
            return;
        }
        res.json({ message: 'deleted' });
    });

    router.put('/fs/move', guard, (req: Request, res: Response) => transfer(req, res, 'move'));
    router.put('/fs/copy', guard, (req: Request, res: Response) => transfer(req, res, 'copy'));

    /**
     * Move or copy one entry, both of which the manager reaches through the same shape of request.
     *
     * @param req request being answered
     * @param res response to answer
     * @param mode whether the source is moved or copied
     */
    function transfer(req: Request, res: Response, mode: 'move' | 'copy'): void {
        const roots = ctx.roots();
        const source = resolvePath(roots, req.query.src as string | undefined);
        const destination = resolvePath(roots, req.query.target as string | undefined);
        if (!source || !destination || destination.mounted || (mode === 'move' && source.mounted)) {
            readOnly(res, 'path is not allowed');
            return;
        }
        if (!fs.existsSync(source.absolute)) {
            res.status(404).json({ message: 'source does not exist' });
            return;
        }

        const target = writeTarget(roots, destination.relative);
        if (fs.existsSync(target) && req.query.force !== 'true') {
            res.status(406).json({ message: 'target does exist' });
            return;
        }

        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.cpSync(source.absolute, target, { recursive: true, force: true });
            if (mode === 'move') {
                fs.rmSync(writeTarget(roots, source.relative), { recursive: true, force: true });
            }
        } catch (e) {
            failed(res, e);
            return;
        }
        res.json({ message: mode === 'move' ? 'moved' : 'copied' });
    }

    // The hidden config holds settings that are not part of a visualisation config. Nothing in
    // CometVisu reads it at runtime - only the PHP backend did, for InfluxDB credentials - so it is
    // plain JSON beside the configs here.
    const hiddenFile = (roots: ManagerRoots): string => writeTarget(roots, 'hidden.json');

    /**
     * The whole hidden config, an empty one while nothing was stored yet.
     *
     * @param roots directories of this instance
     */
    const readHidden = (roots: ManagerRoots): Record<string, Record<string, string>> => {
        const file = hiddenFile(roots);
        if (!fs.existsSync(file)) {
            return {};
        }
        try {
            const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
            return parsed && typeof parsed === 'object' ? (parsed as Record<string, Record<string, string>>) : {};
        } catch {
            ctx.log.warn(`CometVisu manager: ${file} is not readable as JSON, starting over`);
            return {};
        }
    };

    /**
     * Store the whole hidden config.
     *
     * @param roots directories of this instance
     * @param value what to store
     */
    const writeHidden = (roots: ManagerRoots, value: Record<string, Record<string, string>>): void => {
        const file = hiddenFile(roots);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    };

    router.get(['/config/hidden', '/config/hidden/:section', '/config/hidden/:section/:key'], (req, res) => {
        const hidden = readHidden(ctx.roots());
        const { section, key } = req.params as { section?: string; key?: string };
        if (!section) {
            res.json(hidden);
            return;
        }
        if (!key) {
            res.json(hidden[section] ?? {});
            return;
        }
        if (!Object.prototype.hasOwnProperty.call(hidden[section] ?? {}, key)) {
            res.status(404).json({ message: 'config option does not exist' });
            return;
        }
        res.json(hidden[section][key]);
    });

    router.put('/config/hidden', guard, express.json({ limit: '1mb' }), (req: Request, res: Response) => {
        if (!req.body || typeof req.body !== 'object') {
            res.status(405).json({ message: 'expected an object' });
            return;
        }
        writeHidden(ctx.roots(), req.body as Record<string, Record<string, string>>);
        res.json({ message: 'saved' });
    });

    for (const method of ['post', 'put'] as const) {
        router[method]('/config/hidden/:section/:key', guard, body, (req: Request, res: Response) => {
            const roots = ctx.roots();
            const hidden = readHidden(roots);
            const { section, key } = req.params as { section: string; key: string };
            const exists = Object.prototype.hasOwnProperty.call(hidden[section] ?? {}, key);
            if (method === 'post' && exists) {
                res.status(404).json({ message: 'config option does exist' });
                return;
            }
            if (method === 'put' && !exists) {
                res.status(404).json({ message: 'config option does not exist' });
                return;
            }
            hidden[section] = hidden[section] ?? {};
            hidden[section][key] = typeof req.body === 'string' ? req.body : '';
            writeHidden(roots, hidden);
            res.json({ message: 'saved' });
        });
    }

    router.delete('/config/hidden/:section/:key', guard, (req: Request, res: Response) => {
        const roots = ctx.roots();
        const hidden = readHidden(roots);
        const { section, key } = req.params as { section: string; key: string };
        if (!Object.prototype.hasOwnProperty.call(hidden[section] ?? {}, key)) {
            res.status(404).json({ message: 'config option does not exist' });
            return;
        }
        delete hidden[section][key];
        if (Object.keys(hidden[section]).length === 0) {
            delete hidden[section];
        }
        writeHidden(roots, hidden);
        res.json({ message: 'deleted' });
    });

    // The designs shipped with the build, so the editor can offer them for the "design" attribute.
    router.get('/data/designs', (_req: Request, res: Response) => {
        const roots = ctx.roots();
        const names = new Set<string>();
        for (const root of [roots.build, roots.overlay]) {
            if (!root) {
                continue;
            }
            const designs = path.join(path.dirname(root), 'designs');
            try {
                for (const entry of fs.readdirSync(designs, { withFileTypes: true })) {
                    if (entry.isDirectory()) {
                        names.add(entry.name);
                    }
                }
            } catch {
                // no designs here, the other root may have them
            }
        }
        res.json([...names].sort((a, b) => a.localeCompare(b)).map(name => ({ value: name, label: name })));
    });

    // Where the PHP backend reads KNX group addresses from a file, this one asks ioBroker for its
    // states - the editor then completes over what the system really has.
    router.get('/data/addresses', (_req: Request, res: Response) => {
        ctx.addresses().then(
            entries => res.json(entries),
            (e: Error) => failed(res, e),
        );
    });

    return router;
}
