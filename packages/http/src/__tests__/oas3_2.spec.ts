import { createLogger } from '@stoplight/prism-core';
import { resolve } from 'path';
import { IHttpRequest } from '../';
import { createAndCallPrismInstanceWithSpec, PrismErrorResult, PrismOkResult } from '../instanceWithSpec';
import { getHttpOperationsFromSpec } from '../utils/operations';
import { IHttpConfig } from '../types';

const logger = createLogger('TEST', { enabled: false });
const specPath = resolve(__dirname, 'fixtures', 'oas3_2-methods.yaml');

const config: IHttpConfig = {
  validateRequest: true,
  checkSecurity: true,
  validateResponse: true,
  mock: { dynamic: false },
  errors: false,
  upstreamProxy: undefined,
  isProxy: false,
};

// OAS 3.2 adds the QUERY method and Path Item `additionalOperations`; HttpMethod in
// @stoplight/types does not list them yet, hence the casts.
const request = (method: string, body?: unknown): IHttpRequest =>
  ({
    method,
    url: { path: '/search' },
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body } : {}),
  } as unknown as IHttpRequest);

describe('OpenAPI 3.2', () => {
  it('extracts query and additionalOperations as operations', async () => {
    const operations = await getHttpOperationsFromSpec(specPath);
    expect(operations.map(op => op.method)).toEqual(['query', 'copy']);
  });

  it('routes and mocks a QUERY request', async () => {
    const result = await createAndCallPrismInstanceWithSpec(specPath, config, request('query', { term: 'x' }), logger);
    expect(result.result).toBe('ok');
    const output = (result as PrismOkResult).response.output;
    expect(output.statusCode).toBe(200);
    expect(output.body).toEqual(['a', 'b']);
  });

  it('validates the QUERY request body', async () => {
    const result = await createAndCallPrismInstanceWithSpec(specPath, config, request('query', {}), logger);
    expect(result.result).toBe('error');
    expect((result as PrismErrorResult).error).toMatchObject({ status: 422 });
  });

  it('routes and mocks a custom method from additionalOperations', async () => {
    const result = await createAndCallPrismInstanceWithSpec(specPath, config, request('COPY'), logger);
    expect(result.result).toBe('ok');
    const output = (result as PrismOkResult).response.output;
    expect(output.statusCode).toBe(201);
    expect(output.body).toEqual({ copied: true });
  });

  it('returns 405 for a method not defined on the path', async () => {
    const result = await createAndCallPrismInstanceWithSpec(specPath, config, request('get'), logger);
    expect(result.result).toBe('error');
    expect((result as PrismErrorResult).error).toMatchObject({ status: 405 });
  });
});
