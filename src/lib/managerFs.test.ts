import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    BACKUP_ON_CHANGE,
    type ManagerRoots,
    backupName,
    buildRoots,
    isInside,
    listNames,
    normalizeRelative,
    resolvePath,
    writeTarget,
} from './managerFs';

describe('managerFs', () => {
    let tmp: string;
    let dataDir: string;
    let htmlRoot: string;
    let roots: ManagerRoots;

    /**
     * @param file path below the temporary directory
     * @param content content to write
     */
    function write(file: string, content: string): void {
        const target = path.join(tmp, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-managerfs-'));
        dataDir = path.join(tmp, 'data');
        htmlRoot = path.join(tmp, 'build');

        // a build as it is unpacked, and an overlay as the user edited it
        write('build/resource/config/visu_config.xml', '<pages/>');
        write('build/resource/config/from-build-only.xml', '<pages/>');
        write('build/resource/demo/visu_config_demo.xml', '<demo/>');
        write('build/resource/custom_visu_config.xsd', '<xsd/>');
        write('data/resource/config/visu_config.xml', '<edited/>');
        write('data/resource/config/own.xml', '<own/>');

        roots = buildRoots(dataDir, htmlRoot);
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    describe('normalizeRelative', () => {
        it('treats nothing, a dot and a single slash as the root', () => {
            for (const value of [undefined, null, '', '.', '/', '   ']) {
                expect(normalizeRelative(value)).to.equal('');
            }
        });

        it('strips redundant separators and accepts backslashes as separators', () => {
            expect(normalizeRelative('./a//b/')).to.equal('a/b');
            expect(normalizeRelative('a\\b')).to.equal('a/b');
        });

        it('rejects every attempt to climb out', () => {
            for (const value of ['..', '../x', 'a/../../b', 'a/..', '.\\..\\b']) {
                expect(normalizeRelative(value), value).to.equal(null);
            }
        });

        it('reads a leading slash as the config root, the way CometVisu writes it', () => {
            // FileItem.getFullPath() yields e.g. "/visu_config_previewtemp.xml" for the preview file
            expect(normalizeRelative('/visu_config_previewtemp.xml')).to.equal('visu_config_previewtemp.xml');
            expect(normalizeRelative('/')).to.equal('');
            expect(normalizeRelative('//a//b')).to.equal('a/b');
        });

        it('still refuses to climb out through a leading slash', () => {
            expect(normalizeRelative('/../etc/passwd')).to.equal(null);
            expect(normalizeRelative('/a/../../b')).to.equal(null);
        });

        it('rejects a NUL byte', () => {
            expect(normalizeRelative('a\0b')).to.equal(null);
        });
    });

    describe('resolvePath', () => {
        it('refuses anything normalizeRelative refuses', () => {
            for (const value of ['../secret', '/../etc/passwd', 'a/../../b']) {
                expect(resolvePath(roots, value), value).to.equal(null);
            }
        });

        it('keeps an absolute looking path inside the config directory', () => {
            // "/etc/passwd" must never reach the real file - it addresses the config root instead
            const resolved = resolvePath(roots, '/etc/passwd');

            expect(resolved?.absolute).to.equal(path.join(dataDir, 'resource', 'config', 'etc', 'passwd'));
            expect(isInside(path.join(dataDir, 'resource', 'config'), resolved!.absolute)).to.equal(true);
        });

        it('prefers the overlay over the build', () => {
            const resolved = resolvePath(roots, 'visu_config.xml');
            expect(resolved?.absolute).to.equal(path.join(dataDir, 'resource', 'config', 'visu_config.xml'));
            expect(fs.readFileSync(resolved!.absolute, 'utf8')).to.equal('<edited/>');
        });

        it('falls back to the build for a file the overlay does not have', () => {
            const resolved = resolvePath(roots, 'from-build-only.xml');
            expect(resolved?.absolute).to.equal(path.join(htmlRoot, 'resource', 'config', 'from-build-only.xml'));
            expect(resolved?.writeable).to.equal(true);
        });

        it('points a file that exists nowhere at the overlay, where it would be created', () => {
            const resolved = resolvePath(roots, 'new.xml');
            expect(resolved?.absolute).to.equal(path.join(dataDir, 'resource', 'config', 'new.xml'));
        });

        it('serves a mount from the build and never allows writing it', () => {
            const resolved = resolvePath(roots, 'demo/visu_config_demo.xml');
            expect(resolved?.absolute).to.equal(path.join(htmlRoot, 'resource', 'demo', 'visu_config_demo.xml'));
            expect(resolved?.mounted).to.equal(true);
            expect(resolved?.writeable).to.equal(false);
        });

        it('marks entries inside the trash folder', () => {
            expect(resolvePath(roots, '.trash')?.inTrash).to.equal(true);
            expect(resolvePath(roots, '.trash/old.xml')?.inTrash).to.equal(true);
            expect(resolvePath(roots, 'own.xml')?.inTrash).to.equal(false);
        });

        it('refuses a symlink that leaves the overlay', () => {
            const outside = path.join(tmp, 'outside.txt');
            fs.writeFileSync(outside, 'secret');
            fs.symlinkSync(outside, path.join(dataDir, 'resource', 'config', 'escape.txt'));

            expect(resolvePath(roots, 'escape.txt')).to.equal(null);
        });

        it('refuses a symlinked directory that leaves the overlay', () => {
            fs.mkdirSync(path.join(tmp, 'elsewhere'), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'elsewhere', 'secret.xml'), 'secret');
            fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(dataDir, 'resource', 'config', 'link'));

            expect(resolvePath(roots, 'link/secret.xml')).to.equal(null);
        });
    });

    describe('writeTarget', () => {
        it('always writes into the overlay, also for a file that came from the build', () => {
            expect(writeTarget(roots, 'from-build-only.xml')).to.equal(
                path.join(dataDir, 'resource', 'config', 'from-build-only.xml'),
            );
            expect(writeTarget(roots, '')).to.equal(path.join(dataDir, 'resource', 'config'));
        });
    });

    describe('listNames', () => {
        it('merges both roots and lists a file edited in the overlay only once', () => {
            const names = listNames(roots, '');

            expect(names).to.include('visu_config.xml');
            expect(names.filter(n => n === 'visu_config.xml')).to.have.length(1);
            expect(names).to.include('from-build-only.xml');
            expect(names).to.include('own.xml');
        });

        it('shows a visible mount beside the config directory, but not a hidden one', () => {
            const names = listNames(roots, '');

            expect(names).to.include('demo');
            expect(names).to.not.include('resource/custom_visu_config.xsd');
            expect(names).to.not.include('custom_visu_config.xsd');
        });

        it('lists the content of a mount, which the config directory does not have', () => {
            expect(listNames(roots, 'demo')).to.deep.equal(['visu_config_demo.xml']);
        });

        it('returns nothing for a path that is no directory', () => {
            expect(listNames(roots, 'visu_config.xml')).to.deep.equal([]);
        });

        it('works while no build is served', () => {
            const overlayOnly = buildRoots(dataDir, null);

            expect(overlayOnly.build).to.equal(null);
            expect(overlayOnly.mounts).to.deep.equal([]);
            expect(listNames(overlayOnly, '')).to.deep.equal(['own.xml', 'visu_config.xml']);
        });
    });

    describe('backupName', () => {
        it('puts a timestamp in front of the suffix', () => {
            expect(backupName('visu_config.xml', new Date(2026, 8, 7, 4, 5, 6))).to.equal(
                'visu_config-20260907040506.xml',
            );
        });

        it('appends the timestamp when there is no suffix', () => {
            expect(backupName('notes', new Date(2026, 11, 31, 23, 59, 59))).to.equal('notes-20261231235959');
        });

        it('keeps every dot but the last one', () => {
            expect(backupName('visu_config.tile.xml', new Date(2026, 0, 2, 3, 4, 5))).to.equal(
                'visu_config.tile-20260102030405.xml',
            );
        });
    });

    describe('BACKUP_ON_CHANGE', () => {
        it('covers the configs, but not the preview the editor writes while typing', () => {
            expect(BACKUP_ON_CHANGE.test('visu_config.xml')).to.equal(true);
            expect(BACKUP_ON_CHANGE.test('visu_config_tile.xml')).to.equal(true);
            expect(BACKUP_ON_CHANGE.test('visu_config_previewtemp.xml')).to.equal(false);
            expect(BACKUP_ON_CHANGE.test('hidden.php')).to.equal(false);
        });
    });

    describe('isInside', () => {
        it('accepts the root itself and what lies below it', () => {
            expect(isInside(dataDir, dataDir)).to.equal(true);
            expect(isInside(dataDir, path.join(dataDir, 'resource', 'config'))).to.equal(true);
        });

        it('rejects a sibling whose name starts with the root name', () => {
            fs.mkdirSync(`${dataDir}-other`, { recursive: true });

            expect(isInside(dataDir, `${dataDir}-other`)).to.equal(false);
        });
    });
});
