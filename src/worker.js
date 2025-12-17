import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;

const encodeAwarenessMessage = (awarenessUpdate) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessUpdate);
  return encoding.toUint8Array(encoder);
};

/**
 * Durable Objectクラス
 */
export class WhiteboardRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
    this.ydoc = new Y.Doc();
    this.awareness = new Awareness(this.ydoc);
    this.passcode = null;

    this.state.blockConcurrencyWhile(async () => {
      const [storedDoc, storedPasscode] = await Promise.all([
        this.state.storage.get('yjsDoc'),
        this.state.storage.get('passcode'),
      ]);
      if (storedDoc) {
        Y.applyUpdate(this.ydoc, new Uint8Array(storedDoc));
      }
      if (storedPasscode) {
        this.passcode = storedPasscode;
      }
    });

    this.ydoc.on('update', (update, origin) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin);
      this.state.storage.put(
        'yjsDoc',
        Y.encodeStateAsUpdate(this.ydoc)
      );
    });

    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated);
      if (changed.length > 0) {
        const update = encodeAwarenessUpdate(this.awareness, changed);
        this.broadcast(encodeAwarenessMessage(update), origin);
      }

      if (removed.length > 0) {
        const update = encodeAwarenessUpdate(
          this.awareness,
          removed,
          new Map()
        );
        this.broadcast(encodeAwarenessMessage(update), origin);
      }
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const url = new URL(request.url);
    const userPasscode = url.searchParams.get('passcode') || '';

    if (this.passcode !== null && userPasscode !== this.passcode) {
      return new Response('Invalid passcode', { status: 401 });
    }

    if (this.passcode === null && userPasscode) {
      this.passcode = userPasscode;
      await this.state.storage.put('passcode', userPasscode);
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  handleSession(ws) {
    ws.accept();
    const session = {};
    this.sessions.set(ws, session);

    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, this.ydoc);
    ws.send(encoding.toUint8Array(syncEncoder));

    const awarenessUpdate = encodeAwarenessUpdate(
      this.awareness,
      Array.from(this.awareness.getStates().keys())
    );
    ws.send(encodeAwarenessMessage(awarenessUpdate));

    ws.addEventListener('message', (event) => {
      const data =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : ArrayBuffer.isView(event.data)
            ? new Uint8Array(
                event.data.buffer,
                event.data.byteOffset,
                event.data.byteLength
              )
            : null;
      if (!data) {
        return;
      }

      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);

      if (type === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(
          decoder,
          encoder,
          this.ydoc,
          session
        );
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
      } else if (type === MESSAGE_AWARENESS) {
        applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          session
        );
      } else if (type === MESSAGE_QUERY_AWARENESS) {
        const update = encodeAwarenessUpdate(
          this.awareness,
          Array.from(this.awareness.getStates().keys())
        );
        ws.send(encodeAwarenessMessage(update));
      } else if (type === MESSAGE_AUTH) {
        // Not used; ignore for now.
      }
    });

    ws.addEventListener('close', () => {
      const clientIDs = Array.from(this.awareness.getStates().keys());
      if (clientIDs.length > 0) {
        this.awareness.removeStates(clientIDs, 'disconnect');
      }

      this.sessions.delete(ws);

      if (this.sessions.size === 0) {
        this.passcode = null;
        this.state.storage.delete('passcode');
      }
    });

    ws.addEventListener('error', (err) => {
      console.error('WebSocket error', err);
    });
  }

  broadcast(message, origin) {
    for (const [ws, session] of this.sessions.entries()) {
      if (session !== origin) {
        try {
          ws.send(message);
        } catch {
          this.sessions.delete(ws);
        }
      }
    }
  }
}

const WEBSOCKET_PATH = 'websocket';

const isWebSocketUpgrade = (request) =>
  request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

const getRoomNameFromPath = (pathname) => {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return '';
  }
  if (segments[0] === WEBSOCKET_PATH) {
    return segments.slice(1).join('/');
  }
  if (segments.length === 1) {
    return segments[0];
  }
  return '';
};

const getRoomName = (url) =>
  url.searchParams.get('room') || getRoomNameFromPath(url.pathname);

/**
 * Worker エントリーポイント
 * ★ WebSocket Upgrade を最優先で DO に渡す ★
 */
export default {
  async fetch(request, env) {
    if (isWebSocketUpgrade(request)) {
      const url = new URL(request.url);
      const roomName = getRoomName(url);
      if (!roomName) {
        return new Response('Missing room parameter', { status: 400 });
      }

      const id = env.WHITEBOARD_ROOMS_V2.idFromName(roomName);
      const stub = env.WHITEBOARD_ROOMS_V2.get(id);
      return stub.fetch(request);
    }

    return new Response('OK');
  },
};
