import { IPrismDiagnostic } from '@stoplight/prism-core';
import { DiagnosticSeverity } from '@stoplight/types';
import * as O from 'fp-ts/Option';
import { pipe } from 'fp-ts/function';
import { NonEmptyArray, fromArray, map } from 'fp-ts/NonEmptyArray';
import Ajv, { ErrorObject, Logger, Options, ValidateFunction } from 'ajv';
import type AjvCore from 'ajv/dist/core';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { JSONSchema } from '../../';
import { compareDateTime, date_time, fmtDef } from './dateTime';
import { ValidationContext } from './types';

const unknownFormatSilencerLogger: Logger = {
  warn(...args: unknown[]): void {
    const firstArg = args[0];
    if (typeof firstArg === 'string' && firstArg.startsWith('unknown format')) {
      return;
    }

    console.warn(...args);
  },
  log: console.log,
  error: console.error,
};

const baseAjvOptions: Partial<Options> = {
  allErrors: true,
  allowUnionTypes: true,
  allowMatchingProperties: true,
  strict: false,
  logger: unknownFormatSilencerLogger,
};

function createAjvInstances(Ajv: typeof AjvCore) {
  const ajv = new Ajv({ ...baseAjvOptions, coerceTypes: true });
  const ajvNoCoerce = new Ajv({ ...baseAjvOptions, coerceTypes: false });

  addFormats(ajv);
  addFormats(ajvNoCoerce);

  ajv.addFormat('date-time', fmtDef(date_time, compareDateTime));
  ajvNoCoerce.addFormat('date-time', fmtDef(date_time, compareDateTime));

  return {
    coerce: ajv,
    noCoerce: ajvNoCoerce,
  };
}

const ajvInstances = {
  default: createAjvInstances(Ajv),
  draft2019_09: createAjvInstances(Ajv2019),
  draft2020_12: createAjvInstances(Ajv2020),
};

const JSON_SCHEMA_DRAFT_2019_09 = /^https?:\/\/json-schema.org\/draft\/2019-09\/schema#?$/;
const JSON_SCHEMA_DRAFT_2020_12 = /^https?:\/\/json-schema.org\/draft\/2020-12\/schema#?$/;
// The OAS 3.1 / 3.2 base dialects are JSON Schema 2020-12 plus the OAS vocabulary (discriminator, xml, ...).
// 3.1: https://spec.openapis.org/oas/3.1/dialect/base, 3.2: https://spec.openapis.org/oas/3.2/dialect/2025-09-17
const OAS_3_1_DIALECT = /^https?:\/\/spec\.openapis\.org\/oas\/3\.[12]\/dialect\/[\w-]+#?$/;
const JSON_SCHEMA_DRAFT_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema';

function assignAjvInstance($schema: string, coerce: boolean): AjvCore {
  const member = coerce ? 'coerce' : 'noCoerce';
  let draft: keyof typeof ajvInstances = 'default';

  if (JSON_SCHEMA_DRAFT_2019_09.test($schema)) {
    draft = 'draft2019_09';
  } else if (JSON_SCHEMA_DRAFT_2020_12.test($schema) || OAS_3_1_DIALECT.test($schema)) {
    draft = 'draft2020_12';
  }

  return ajvInstances[draft][member];
}

// Ajv refuses to compile a schema whose $schema it has no meta-schema for, which would make
// validation silently pass. Point the OAS dialect at the 2020-12 meta-schema it extends.
function normalizeDialect(schema: JSONSchema): JSONSchema {
  return typeof schema.$schema === 'string' && OAS_3_1_DIALECT.test(schema.$schema)
    ? { ...schema, $schema: JSON_SCHEMA_DRAFT_2020_12_URI }
    : schema;
}

export const convertAjvErrors = (
  errors: NonEmptyArray<ErrorObject>,
  severity: DiagnosticSeverity,
  context: ValidationContext,
  prefix?: string
) =>
  pipe(
    errors,
    map<ErrorObject, IPrismDiagnostic>(error => {
      const allowedParameters = 'allowedValues' in error.params ? `: ${error.params.allowedValues.join(', ')}` : '';
      const detectedAdditionalProperties =
        'additionalProperty' in error.params ? `; found '${error.params.additionalProperty}'` : '';
      const unevaluatedProperty =
        'unevaluatedProperty' in error.params ? `: '${error.params.unevaluatedProperty}'` : '';
      const errorPath = error.instancePath.split('/').filter(segment => segment !== '');
      const path = prefix ? [prefix, ...errorPath] : errorPath;
      const errorPathType = errorPath.length > 0 ? (prefix == 'body' ? 'property ' : 'parameter ') : '';
      const errorSourceDescription =
        `${context === ValidationContext.Input ? 'Request' : 'Response'} ` +
        (prefix ? `${prefix} ` : '') +
        errorPathType +
        errorPath.join('.').trim() +
        (errorPath.length > 0 ? ' ' : '');

      return {
        path,
        code: error.keyword || '',
        message: `${errorSourceDescription}${error.message || ''}${allowedParameters}${detectedAdditionalProperties}${unevaluatedProperty}`,
        severity,
      };
    })
  );

const validationsFunctionsCache = new WeakMap<JSONSchema, WeakMap<object, ValidateFunction>>();
const EMPTY_BUNDLE = { _emptyBundle: true };

function getValidationFunction(ajvInstance: AjvCore, schema: JSONSchema, bundle?: unknown): ValidateFunction {
  const bundledFunctionsCache = validationsFunctionsCache.get(schema);
  const bundleKey = typeof bundle === 'object' && bundle !== null ? bundle : EMPTY_BUNDLE;
  if (bundledFunctionsCache) {
    const validationFunction = bundledFunctionsCache.get(bundleKey);
    if (validationFunction) {
      return validationFunction;
    }
  }

  const validationFunction = ajvInstance.compile({
    ...normalizeDialect(schema),
    __bundled__: bundle,
  });

  if (!bundledFunctionsCache) {
    validationsFunctionsCache.set(schema, new WeakMap());
  }

  validationsFunctionsCache.get(schema)!.set(bundleKey, validationFunction);
  return validationFunction;
}

export const validateAgainstSchema = (
  value: unknown,
  schema: JSONSchema,
  coerce: boolean,
  context: ValidationContext,
  prefix?: string,
  bundle?: unknown
): O.Option<NonEmptyArray<IPrismDiagnostic>> =>
  pipe(
    O.tryCatch(() => getValidationFunction(assignAjvInstance(String(schema.$schema), coerce), schema, bundle)),
    O.chainFirst(validateFn => O.tryCatch(() => validateFn(value))),
    O.chain(validateFn => pipe(O.fromNullable(validateFn.errors), O.chain(fromArray))),
    O.map(errors => convertAjvErrors(errors, DiagnosticSeverity.Error, context, prefix))
  );
