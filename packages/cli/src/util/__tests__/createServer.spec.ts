// Regression test for https://github.com/stoplightio/prism/issues/2763
// `node:cluster` has no `default` export at runtime. Under `esModuleInterop: false`
// a default import compiles to `cluster.default.isPrimary`, which throws on startup
// whenever multiprocess mode is on (the default when NODE_ENV=production, e.g. Docker).
const mockFork = jest.fn(() => ({ process: {} }));
const mockSetupPrimary = jest.fn();

jest.mock('node:cluster', () => ({
  isPrimary: true,
  setupPrimary: mockSetupPrimary,
  fork: mockFork,
}));

import { createMultiProcessPrism } from '../createServer';

describe('createMultiProcessPrism()', () => {
  it('forks a worker from the primary process using the CommonJS cluster module', async () => {
    await expect(
      createMultiProcessPrism({
        document: 'irrelevant.yaml',
        cors: true,
        host: '127.0.0.1',
        port: 4010,
        multiprocess: true,
        errors: false,
        verboseLevel: 'info',
        ignoreExamples: false,
        dynamic: false,
        jsonSchemaFakerFillProperties: true,
        upstream: new URL('http://example.com'),
        upstreamProxy: undefined,
        validateRequest: true,
      } as any)
    ).resolves.toBeUndefined();

    expect(mockSetupPrimary).toHaveBeenCalledWith({ silent: true });
    expect(mockFork).toHaveBeenCalledTimes(1);
  });
});
