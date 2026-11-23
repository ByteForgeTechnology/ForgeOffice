import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from './auth';

let socket: Socket | null = null;

/** Shared Socket.IO connection; the token is re-read on every (re)connect. */
export function getSocket(): Socket {
  socket ??= io({
    path: '/socket.io',
    transports: ['websocket'],
    auth: (cb) => {
      void getAccessToken().then((token) => cb({ token }));
    },
  });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function useSocketEvent<T>(event: string, handler: (payload: T) => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const s = getSocket();
    const listener = (p: T) => ref.current(p);
    s.on(event, listener);
    return () => {
      s.off(event, listener);
    };
  }, [event, enabled]);
}

export function useSocketConnected(enabled = true): boolean {
  const [connected, setConnected] = useState(() => (enabled ? getSocket().connected : false));
  useEffect(() => {
    if (!enabled) return;
    const s = getSocket();
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    s.on('connect', on);
    s.on('disconnect', off);
    setConnected(s.connected);
    return () => {
      s.off('connect', on);
      s.off('disconnect', off);
    };
  }, [enabled]);
  return connected;
}
