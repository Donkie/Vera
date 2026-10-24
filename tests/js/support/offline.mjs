import { Socket } from 'node:net';

// Fail closed if a test forgets to mock an external service, including localhost models.
globalThis.fetch = () => { throw new Error('Network disabled in tests: inject a mock fetcher'); };
Socket.prototype.connect = () => { throw new Error('Network disabled in tests'); };
