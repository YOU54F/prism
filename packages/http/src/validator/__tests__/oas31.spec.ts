import { IHttpOperation } from '@stoplight/types';
import * as E from 'fp-ts/Either';
import { getHttpOperationsFromSpec } from '../../utils/operations';
import { validateInput } from '../index';

// Regression tests for https://github.com/stoplightio/prism/issues/2797 (and #2082):
// OAS 3.1 schemas must be validated as JSON Schema 2020-12 even when no `$schema` is declared.

const bodySchema = {
  type: 'object',
  properties: {
    point: {
      type: 'array',
      prefixItems: [{ type: 'number' }, { type: 'string' }],
      items: false,
    },
    kind: { const: 'pet' },
    nickname: { type: ['string', 'null'] },
    tag: { $ref: '#/components/schemas/Tag' },
  },
  unevaluatedProperties: false,
};

const buildDocument = (openapi: string, extra: Record<string, unknown> = {}, schema: object = bodySchema) => ({
  openapi,
  info: { title: 'oas31', version: '1.0.0' },
  ...extra,
  components: { schemas: { Tag: { type: 'string', maxLength: 3 } } },
  paths: {
    '/pets': {
      post: {
        requestBody: {
          required: true,
          content: { 'application/json': { schema } },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
});

const validate = (operation: IHttpOperation, body: unknown) =>
  validateInput({
    resource: operation,
    element: {
      method: 'post',
      url: { path: '/pets' },
      headers: { 'content-type': 'application/json' },
      body,
    },
  });

const errorCodes = (result: ReturnType<typeof validate>) =>
  E.isLeft(result) ? result.left.map(e => e.code).sort() : [];

describe('OAS 3.1 schema validation', () => {
  const validBody = { point: [1, 'a'], kind: 'pet', nickname: null, tag: 'abc' };

  describe.each([
    ['openapi 3.1.0 without jsonSchemaDialect', buildDocument('3.1.0')],
    [
      'openapi 3.1.0 with JSON Schema 2020-12 jsonSchemaDialect',
      buildDocument('3.1.0', { jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema' }),
    ],
    [
      'openapi 3.1.0 with the OAS base jsonSchemaDialect',
      buildDocument('3.1.0', { jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base' }),
    ],
    ['openapi 3.2.0 without jsonSchemaDialect', buildDocument('3.2.0')],
    [
      'openapi 3.2.0 with the OAS 3.2 jsonSchemaDialect',
      buildDocument('3.2.0', { jsonSchemaDialect: 'https://spec.openapis.org/oas/3.2/dialect/2025-09-17' }),
    ],
  ])('%s', (_, document) => {
    let operation: IHttpOperation;

    beforeAll(async () => {
      [operation] = await getHttpOperationsFromSpec(document);
    });

    it('accepts a valid body', () => {
      expect(validate(operation, validBody)).toEqual(E.right(expect.anything()));
    });

    it('enforces prefixItems', () => {
      expect(errorCodes(validate(operation, { ...validBody, point: ['a', 1] }))).toEqual(['type', 'type']);
    });

    it('enforces items: false after prefixItems', () => {
      expect(errorCodes(validate(operation, { ...validBody, point: [1, 'a', true] }))).toEqual(['items']);
    });

    it('enforces const', () => {
      expect(errorCodes(validate(operation, { ...validBody, kind: 'cat' }))).toEqual(['const']);
    });

    it('enforces referenced component schemas', () => {
      expect(errorCodes(validate(operation, { ...validBody, tag: 'toolong' }))).toEqual(['maxLength']);
    });

    it('enforces unevaluatedProperties', () => {
      expect(errorCodes(validate(operation, { ...validBody, extra: 1 }))).toEqual(['unevaluatedProperties']);
    });
  });

  it('honours an explicit per-schema $schema in an OAS 3.1 document', async () => {
    // draft-07 has no prefixItems keyword, so it is ignored when the schema opts into draft-07
    const [operation] = await getHttpOperationsFromSpec(
      buildDocument(
        '3.1.0',
        {},
        {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'array',
          prefixItems: [{ type: 'number' }],
        }
      )
    );
    expect(errorCodes(validate(operation, ['a']))).toEqual([]);
  });

  it('keeps draft-07 semantics for OAS 3.0 documents', async () => {
    const [operation] = await getHttpOperationsFromSpec(
      buildDocument('3.0.3', {}, { type: 'object', properties: { nickname: { type: 'string', nullable: true } } })
    );
    expect(operation.request?.body?.contents?.[0].schema?.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(validate(operation, { nickname: null })).toEqual(E.right(expect.anything()));
    expect(errorCodes(validate(operation, { nickname: 1 }))).toEqual(['type']);
  });
});
