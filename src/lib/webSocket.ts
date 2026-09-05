// Which socket a web instance offers, and which protocol it speaks. CometVisu can talk both the raw
// ws framing of @iobroker/ws and socket.io, but it has to be told which one - it cannot find out on its
// own. The rules below are those of iobroker.web 9.1.4 (main.js, lines 556-575 and 2156-2176).

/** Protocol a socket speaks, in the spelling CometVisu expects in the transport header. */
export type SocketTransport = 'ws' | 'socket.io';

/** Where the socket of a web instance lives and what it speaks. */
export type WebSocketSetup =
    /** the web instance serves the socket on its own port */
    | { kind: 'integrated'; transport: SocketTransport }
    /** another adapter instance serves the socket on its own port */
    | { kind: 'external'; transport: SocketTransport; instance: string }
    /** the web instance has no socket at all */
    | { kind: 'none' };

/** The part of a web instance's configuration that decides this. */
export interface WebNative {
    /** empty for the integrated socket, "none", or the id of a socket adapter instance */
    socketio?: string;
    /** whether the integrated socket speaks the raw `@iobroker/ws` framing */
    usePureWebSockets?: boolean;
}

/**
 * Work out which socket the given web instance offers.
 *
 * Note that `usePureWebSockets` is not part of the defaults of iobroker.web, so a freshly created
 * web instance ends up on socket.io.
 *
 * @param native native configuration of the web instance
 */
export function classifyWebSocket(native: WebNative | undefined | null): WebSocketSetup {
    const socketio = native?.socketio || '';

    if (socketio === 'none') {
        return { kind: 'none' };
    }
    if (socketio.startsWith('system.adapter.')) {
        // iobroker.ws speaks the raw framing, every other socket adapter speaks socket.io
        return {
            kind: 'external',
            transport: socketio.startsWith('system.adapter.ws.') ? 'ws' : 'socket.io',
            instance: socketio,
        };
    }
    return { kind: 'integrated', transport: native?.usePureWebSockets ? 'ws' : 'socket.io' };
}
