import { expect } from 'chai';
import { classifyWebSocket } from './webSocket';

describe('classifyWebSocket', () => {
    it('reports the integrated raw websocket when pure websockets are switched on', () => {
        expect(classifyWebSocket({ usePureWebSockets: true })).to.deep.equal({
            kind: 'integrated',
            transport: 'ws',
        });
    });

    it('reports socket.io for a web instance that never got the setting', () => {
        // iobroker.web does not ship usePureWebSockets in its defaults, so this is the common case
        expect(classifyWebSocket({})).to.deep.equal({ kind: 'integrated', transport: 'socket.io' });
        expect(classifyWebSocket(undefined)).to.deep.equal({ kind: 'integrated', transport: 'socket.io' });
    });

    it('reports no socket at all when the web instance was told to serve none', () => {
        expect(classifyWebSocket({ socketio: 'none' })).to.deep.equal({ kind: 'none' });
    });

    it('reports an external iobroker.ws instance as raw websocket', () => {
        expect(classifyWebSocket({ socketio: 'system.adapter.ws.0' })).to.deep.equal({
            kind: 'external',
            transport: 'ws',
            instance: 'system.adapter.ws.0',
        });
    });

    it('reports any other external socket adapter as socket.io', () => {
        expect(classifyWebSocket({ socketio: 'system.adapter.socketio.1' })).to.deep.equal({
            kind: 'external',
            transport: 'socket.io',
            instance: 'system.adapter.socketio.1',
        });
    });

    it('ignores usePureWebSockets once an external socket is configured', () => {
        expect(classifyWebSocket({ socketio: 'system.adapter.socketio.0', usePureWebSockets: true })).to.deep.equal({
            kind: 'external',
            transport: 'socket.io',
            instance: 'system.adapter.socketio.0',
        });
    });
});
