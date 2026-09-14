import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import axios from 'axios';
import {
    type PrepareProgress,
    customBuildDir,
    ensureRelease,
    listCustomBuilds,
    readCustomBuild,
    readReleaseBuild,
    releaseBuildDir,
    unpackUploadedTarball,
} from './releases';

/** The adapter logger, reduced to what the functions under test use. */
const log = {
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    silly: () => undefined,
    level: 'info',
} as unknown as ioBroker.Logger;

describe('releases: uploaded builds', () => {
    let tmp: string;
    let dataDir: string;
    const FILE = 'CometVisu-build.tar.gz';

    /**
     * Pack a directory tree into a .tar.gz, the way an uploaded CometVisu build arrives.
     *
     * @param name file name of the archive below the temporary directory
     * @param files the files of the archive, path below "release/" mapped to its content
     */
    async function pack(name: string, files: Record<string, string>): Promise<string> {
        const content = path.join(tmp, `content-${name}`);
        for (const [file, text] of Object.entries(files)) {
            const target = path.join(content, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, text);
        }
        const archive = path.join(tmp, name);
        await tar.c({ gzip: true, cwd: content, file: archive }, fs.readdirSync(content));
        return archive;
    }

    /**
     * @param source path to the archive to unpack
     */
    function unpack(source: string): Promise<{ tag: string; htmlRoot: string }> {
        return unpackUploadedTarball(source, dataDir, log, { file: FILE, size: 1, modifiedAt: 2 });
    }

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-releases-'));
        dataDir = path.join(tmp, 'data');
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('unpacks an archive into the directory of its file name', async () => {
        const archive = await pack('build.tar.gz', {
            'release/index.html': '<html>first</html>',
            'release/resource/config/visu_config.xml': '<pages/>',
        });

        const result = await unpack(archive);

        const targetDir = customBuildDir(dataDir, FILE);
        expect(result.htmlRoot).to.equal(path.join(targetDir, 'release'));
        expect(fs.readFileSync(path.join(result.htmlRoot, 'index.html'), 'utf8')).to.equal('<html>first</html>');
        expect(fs.existsSync(path.join(targetDir, '.complete'))).to.be.true;
        expect(JSON.parse(fs.readFileSync(path.join(targetDir, '.source'), 'utf8'))).to.deep.equal({
            file: FILE,
            size: 1,
            modifiedAt: 2,
        });
        // nothing of the unpacking is left beside it
        expect(fs.existsSync(`${targetDir}.tmp`)).to.be.false;
    });

    it('replaces the build when the same archive is uploaded again', async () => {
        await unpack(
            await pack('first.tar.gz', { 'release/index.html': '<html>first</html>', 'release/gone.txt': 'x' }),
        );
        const again = await unpack(await pack('second.tar.gz', { 'release/index.html': '<html>second</html>' }));

        expect(fs.readFileSync(path.join(again.htmlRoot, 'index.html'), 'utf8')).to.equal('<html>second</html>');
        // the whole directory is replaced, not merged over
        expect(fs.existsSync(path.join(again.htmlRoot, 'gone.txt'))).to.be.false;
        // still the one directory of that archive, not a second one
        expect(listCustomBuilds(dataDir).map(build => build.file)).to.deep.equal([FILE]);
    });

    it('keeps the previous build when the new archive is no CometVisu build', async () => {
        const first = await unpack(await pack('first.tar.gz', { 'release/index.html': '<html>first</html>' }));
        const broken = await pack('broken.tar.gz', { 'readme.txt': 'no build in here' });

        let message = '';
        try {
            await unpack(broken);
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }

        expect(message).to.contain('no index.html');
        expect(fs.readFileSync(path.join(first.htmlRoot, 'index.html'), 'utf8')).to.equal('<html>first</html>');
        expect(readCustomBuild(dataDir, FILE)?.htmlRoot).to.equal(first.htmlRoot);
        expect(fs.existsSync(`${customBuildDir(dataDir, FILE)}.tmp`)).to.be.false;
    });

    it('reports a missing archive instead of touching the previous build', async () => {
        const first = await unpack(await pack('first.tar.gz', { 'release/index.html': '<html>first</html>' }));

        let message = '';
        try {
            await unpack(path.join(tmp, 'not-there.tar.gz'));
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }

        expect(message).to.contain('not found');
        expect(readCustomBuild(dataDir, FILE)?.htmlRoot).to.equal(first.htmlRoot);
    });
});

describe('releases: GitHub releases', () => {
    const TAG = 'v0.12.6';
    const URL = `https://github.com/CometVisu/CometVisu/releases/download/${TAG}/CometVisu-${TAG}.tar.gz`;
    let tmp: string;
    let dataDir: string;
    let downloads: string[];
    let archive: string;
    const realGet = axios.get;

    /**
     * Pack a directory tree into a .tar.gz, the way a release archive arrives.
     *
     * @param files the files of the archive, path below the archive root mapped to its content
     */
    async function pack(files: Record<string, string>): Promise<string> {
        const content = path.join(tmp, `content-${Object.keys(files).length}-${Math.random()}`);
        for (const [file, text] of Object.entries(files)) {
            const target = path.join(content, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, text);
        }
        const file = path.join(tmp, `archive-${path.basename(content)}.tar.gz`);
        await tar.c({ gzip: true, cwd: content, file }, fs.readdirSync(content));
        return file;
    }

    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-release-'));
        dataDir = path.join(tmp, 'data');
        downloads = [];
        archive = await pack({ 'release/index.html': '<html>release</html>' });
        // the download is the only thing standing between us and GitHub, so it is the only stub
        (axios as unknown as { get: unknown }).get = (url: string) => {
            downloads.push(url);
            return Promise.resolve({ data: fs.createReadStream(archive), headers: {} });
        };
    });

    afterEach(() => {
        (axios as unknown as { get: unknown }).get = realGet;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('unpacks a downloaded release into the directory of its tag', async () => {
        const build = await ensureRelease(dataDir, TAG, URL, log);

        expect(downloads).to.deep.equal([URL]);
        expect(build.tag).to.equal(TAG);
        expect(build.htmlRoot).to.equal(path.join(releaseBuildDir(dataDir, TAG), 'release'));
        expect(fs.readFileSync(path.join(build.htmlRoot, 'index.html'), 'utf8')).to.equal('<html>release</html>');
        expect(fs.existsSync(path.join(releaseBuildDir(dataDir, TAG), '.complete'))).to.be.true;
        expect(fs.existsSync(`${releaseBuildDir(dataDir, TAG)}.tmp`)).to.be.false;
    });

    it('refuses an archive that does not come from the project releases', async () => {
        let message = '';
        try {
            await ensureRelease(dataDir, TAG, 'https://evil.example/CometVisu-v0.12.6.tar.gz', log);
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }

        expect(message).to.contain('is not a download of CometVisu/CometVisu');
        // refused before anything was fetched or written
        expect(downloads).to.deep.equal([]);
        expect(fs.existsSync(releaseBuildDir(dataDir, TAG))).to.be.false;
    });

    it('uses the unpacked build instead of downloading it again', async () => {
        const first = await ensureRelease(dataDir, TAG, URL, log);
        const again = await ensureRelease(dataDir, TAG, URL, log);

        expect(again.htmlRoot).to.equal(first.htmlRoot);
        expect(downloads).to.have.length(1);
    });

    it('leaves nothing behind when the download is no CometVisu build', async () => {
        archive = await pack({ 'readme.txt': 'no build in here' });

        let message = '';
        try {
            await ensureRelease(dataDir, TAG, URL, log);
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }

        expect(message).to.contain('no index.html');
        expect(fs.existsSync(releaseBuildDir(dataDir, TAG))).to.be.false;
        expect(fs.existsSync(`${releaseBuildDir(dataDir, TAG)}.tmp`)).to.be.false;
    });

    it('reports the download and then the unpacking', async () => {
        const size = fs.statSync(archive).size;
        (axios as unknown as { get: unknown }).get = () =>
            Promise.resolve({ data: fs.createReadStream(archive), headers: { 'content-length': String(size) } });
        const seen: PrepareProgress[] = [];

        await ensureRelease(dataDir, TAG, URL, log, p => seen.push(p));

        expect(seen[0]).to.deep.equal({ phase: 'downloading' });
        const downloads = seen.filter(p => p.phase === 'downloading' && p.done !== undefined);
        expect(downloads.length).to.be.greaterThan(0);
        // the count only grows and ends at the announced size
        expect(downloads.map(p => p.done)).to.deep.equal([...downloads.map(p => p.done)].sort((a, b) => a! - b!));
        expect(downloads.at(-1)).to.deep.equal({ phase: 'downloading', done: size, total: size });
        // the unpacking is announced once, and only after the last byte
        expect(seen.filter(p => p.phase === 'unpacking')).to.have.length(1);
        expect(seen.at(-1)).to.deep.equal({ phase: 'unpacking' });
    });

    it('leaves the size open when GitHub announces none', async () => {
        const seen: PrepareProgress[] = [];

        await ensureRelease(dataDir, TAG, URL, log, p => seen.push(p));

        // the stub above sends no content-length
        expect(seen.filter(p => p.done !== undefined).every(p => p.total === undefined)).to.be.true;
    });

    it('reads back only the release that is unpacked', async () => {
        const build = await ensureRelease(dataDir, TAG, URL, log);

        expect(readReleaseBuild(dataDir, TAG)?.htmlRoot).to.equal(build.htmlRoot);
        expect(readReleaseBuild(dataDir, 'v0.0.1')).to.be.null;
        expect(readReleaseBuild(dataDir, '')).to.be.null;
    });
});
