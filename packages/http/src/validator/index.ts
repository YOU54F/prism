import { IPrismDiagnostic, ValidatorFn } from '@stoplight/prism-core';
import {
  DiagnosticSeverity,
  Dictionary,
  IHttpOperation,
  IHttpOperationRequestBody,
  IHttpOperationResponse,
  IMediaTypeContent,
} from '@stoplight/types';
import * as caseless from 'caseless';
import * as contentType from 'content-type';
import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as E from 'fp-ts/Either';
import { sequenceOption, sequenceValidation } from '../combinators';
import { pipe } from 'fp-ts/function';
import { inRange, isMatch } from 'lodash';
import { URI } from 'uri-template-lite';
import { IHttpRequest, IHttpResponse, IHttpNameValue } from '../types';
import { findOperationResponse } from './utils/spec';
import { validateBody, validateHeaders, validatePath, validateQuery } from './validators';
import { NonEmptyArray } from 'fp-ts/NonEmptyArray';
import { ValidationContext } from './validators/types';
import { parseMIMEHeader } from '../validator/validators/headers';
import { wildcardMediaTypeMatch } from './utils/wildcardMediaTypeMatch';

export { validateSecurity } from './validators/security';

const checkRequiredBodyIsProvided = (requestBody: O.Option<IHttpOperationRequestBody>, body: unknown) =>
  pipe(
    requestBody,
    E.fromPredicate<O.Option<IHttpOperationRequestBody>, NonEmptyArray<IPrismDiagnostic>>(
      requestBody => O.isNone(requestBody) || !(!!requestBody.value.required && !body),
      () => [{ code: 'required', message: 'Body parameter is required', severity: DiagnosticSeverity.Error }]
    ),
    E.map(requestBody => [requestBody, O.fromNullable(body)] as const)
  );

const isMediaTypeSupportedInContents = (mediaType?: string, contents?: IMediaTypeContent[]): boolean =>
  pipe(
    O.fromNullable(mediaType),
    O.fold(
      () => true,
      mediaType =>
        pipe(
          O.fromNullable(contents),
          O.fold(
            () => true,
            contents => !!contents.find(x => !x.mediaType || wildcardMediaTypeMatch(mediaType, x.mediaType))
          )
        )
    )
  );

const validateInputIfBodySpecIsProvided = (
  body: O.Option<unknown>,
  requestBody: O.Option<IHttpOperationRequestBody>,
  mediaType?: string,
  multipartBoundary?: string,
  bundle?: unknown
) =>
  pipe(
    sequenceOption(body, requestBody),
    O.fold(
      () => E.right(body),
      ([body, contents]) =>
        validateBody(body, contents.contents ?? [], ValidationContext.Input, mediaType, multipartBoundary, bundle)
    )
  );

const validateInputBody = (
  requestBody: O.Option<IHttpOperationRequestBody>,
  bundle: unknown,
  body: unknown,
  headers: IHttpNameValue
) =>
  pipe(
    checkRequiredBodyIsProvided(requestBody, body),
    E.map(b => [...b, caseless(headers || {})] as const),
    E.chain(([requestBody, body, headers]) => {
      const contentTypeHeader = headers.get('content-type');
      const [multipartBoundary, mediaType] = contentTypeHeader
        ? parseMIMEHeader(contentTypeHeader)
        : [undefined, undefined];

      const contentLengthHeader = headers.get('content-length');
      const contentLength = parseInt(contentLengthHeader) || 0;
      if (contentLength === 0) {
        // generously allow this content type if there isn't a body actually provided.
        // Only an explicit `content-length: 0` means the body is empty: without the header (chunked requests,
        // in-process calls) the body must still be validated.
        const providedBody = contentLengthHeader === undefined ? body : (O.none as O.Option<unknown>);
        return E.right([requestBody, providedBody, mediaType, multipartBoundary] as const);
      }

      let errorMessage = 'No supported content types, but request included a non-empty body';
      if (O.isSome(requestBody)) {
        if (isMediaTypeSupportedInContents(mediaType, requestBody.value.contents)) {
          return E.right([requestBody, body, mediaType, multipartBoundary] as const);
        }

        const specRequestBodyContents = requestBody.value.contents || [];
        if (specRequestBodyContents.length > 0) {
          const supportedContentTypes = specRequestBodyContents.map(x => x.mediaType);
          errorMessage = `Supported content types: ${supportedContentTypes.join(',')}`;
        }
      }

      return E.left<NonEmptyArray<IPrismDiagnostic>>([
        {
          message: errorMessage,
          code: 415,
          severity: DiagnosticSeverity.Error,
        },
      ]);
    }),
    E.chain(([requestBody, body, mediaType, multipartBoundary]) =>
      validateInputIfBodySpecIsProvided(body, requestBody, mediaType, multipartBoundary, bundle)
    )
  );

// OpenAPI 3.x: header parameters named Accept, Content-Type or Authorization SHALL be ignored.
// They are governed by content negotiation, request body media types and security schemes instead.
// https://spec.openapis.org/oas/v3.1.0#fixed-fields-9
const RESERVED_HEADER_PARAM_NAMES = ['accept', 'content-type', 'authorization'];

// Memoised per spec array: the header validator caches its compiled schema by array identity, so returning a new
// array on every request would compile (and retain) a fresh Ajv validator per request.
const filteredHeaderParams = new WeakMap<object[], object[]>();

const withoutReservedHeaderParams = <T extends { name: string }>(headers: T[]): T[] => {
  let filtered = filteredHeaderParams.get(headers) as T[] | undefined;
  if (!filtered) {
    filtered = headers.filter(header => !RESERVED_HEADER_PARAM_NAMES.includes(header.name.toLowerCase()));
    filteredHeaderParams.set(headers, filtered);
  }
  return filtered;
};

export const validateInput: ValidatorFn<IHttpOperation, IHttpRequest> = ({ resource, element }) => {
  const { request } = resource;
  const { body } = element;

  const bundle = resource['__bundled__'];
  return pipe(
    E.fromNullable(undefined)(request),
    E.fold(
      e => E.right<NonEmptyArray<IPrismDiagnostic>, unknown>(e),
      request =>
        sequenceValidation(
          validateInputBody(O.fromNullable(request.body), bundle, body, element.headers || {}),
          request.headers
            ? validateHeaders(
                element.headers || {},
                withoutReservedHeaderParams(request.headers),
                ValidationContext.Input,
                bundle
              )
            : E.right(undefined),
          request.query
            ? validateQuery(element.url.query || {}, request.query, ValidationContext.Input, bundle)
            : E.right(undefined),
          request.path
            ? validatePath(
                getPathParams(element.url.path, resource.path),
                request.path,
                ValidationContext.Input,
                bundle
              )
            : E.right(undefined)
        )
    ),
    E.map(() => element)
  );
};

const findResponseByStatus = (responses: IHttpOperationResponse[], statusCode: number) =>
  pipe(
    findOperationResponse(responses, statusCode),
    E.fromOption<IPrismDiagnostic>(() => ({
      message: `Unable to match the returned status code with those defined in the document: ${responses
        .map(response => response.code)
        .join(',')}`,
      severity: inRange(statusCode, 200, 300) ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    })),
    E.mapLeft<IPrismDiagnostic, NonEmptyArray<IPrismDiagnostic>>(error => [error])
  );

export const validateMediaType = (contents: NonEmptyArray<IMediaTypeContent>, mediaType: string) =>
  pipe(
    O.fromNullable(mediaType),
    O.map(contentType.parse),
    O.chain(parsedMediaType =>
      pipe(
        contents,
        A.findFirst(c => {
          const parsedSelectedContentMediaType = contentType.parse(c.mediaType);
          return (
            wildcardMediaTypeMatch(parsedMediaType.type, parsedSelectedContentMediaType.type) &&
            isMatch(parsedMediaType.parameters, parsedSelectedContentMediaType.parameters)
          );
        })
      )
    ),
    E.fromOption<IPrismDiagnostic>(() => ({
      message: `The received media type "${mediaType || ''}" does not match the one${
        contents.length > 1 ? 's' : ''
      } specified in the current response: ${contents.map(c => c.mediaType).join(', ')}`,
      severity: DiagnosticSeverity.Error,
    })),
    E.mapLeft<IPrismDiagnostic, NonEmptyArray<IPrismDiagnostic>>(e => [e])
  );

export const validateOutput: ValidatorFn<IHttpOperation, IHttpResponse> = ({ resource, element }) => {
  const mediaType = caseless(element.headers || {}).get('content-type');
  const bundle = resource['__bundled__'];
  return pipe(
    findResponseByStatus(resource.responses, element.statusCode),
    E.chain(response =>
      sequenceValidation(
        pipe(
          O.fromNullable(response.contents),
          O.chain(contents => pipe(contents, O.fromPredicate(A.isNonEmpty))),
          O.fold(
            () => E.right<NonEmptyArray<IPrismDiagnostic>, unknown>(undefined),
            contents => validateMediaType(contents, mediaType)
          )
        ),
        validateBody(element.body, response.contents || [], ValidationContext.Output, mediaType, undefined, bundle),
        validateHeaders(element.headers || {}, response.headers || [], ValidationContext.Output, bundle)
      )
    ),
    E.map(() => element)
  );
};

function getPathParams(path: string, template: string): Dictionary<string> {
  return new URI.Template(template).match(path);
}
