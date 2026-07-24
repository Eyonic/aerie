import type { Server } from 'node:http';

type DrainableServer = Pick<Server, 'close'> & Partial<Pick<Server, 'closeIdleConnections'>>;
type StreamCloser = () => number;

export interface HttpDrain {
  closedStreams: number;
  drained: Promise<void>;
}

/**
 * Stop accepting connections before ending SSE responses, then explicitly
 * reap the keep-alive sockets that became idle when those responses ended.
 */
export function beginHttpDrain(
  server: DrainableServer,
  streamClosers: readonly StreamCloser[],
  onCloseError: (error: Error) => void = () => {},
): HttpDrain {
  let resolveDrain!: () => void;
  const drained = new Promise<void>(resolve => { resolveDrain = resolve; });

  // This must remain first: EventSource clients may reconnect as soon as their
  // response ends, so close the listener before ending any live streams.
  server.close(error => {
    if (error) onCloseError(error);
    resolveDrain();
  });

  let closedStreams = 0;
  for (const closeStreams of streamClosers) closedStreams += closeStreams();

  // server.close() only saw the SSE sockets while they were active. res.end()
  // turns them into idle keep-alive sockets, so reap that new idle generation.
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();

  return { closedStreams, drained };
}
