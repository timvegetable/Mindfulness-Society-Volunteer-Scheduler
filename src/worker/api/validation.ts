import { Schema, SchemaAST } from 'effect';
import { RequestEnvelopeSchema, payloadSchemas, resultSchemas, type RequestEnvelope, type Operation, type ResultOf, type PayloadOf } from '../../shared/api/schemas';

type Guard = (value: unknown) => boolean;

/** Compile the validation-only subset of our boundary schemas to direct guards without copying records.
 * Unsupported codecs keep the normal decoder, including its transformations.
 * Filters still come from the shared schema: dates, intervals and limits have one owner.
 */
function guard(ast: SchemaAST.AST): Guard | undefined {
  if (ast.encoding || ast.context?.constructorDefault) return undefined;
  const options = (ast.annotations?.parseOptions ?? {}) as SchemaAST.ParseOptions;
  let shape: Guard;
  switch (ast._tag) {
    case 'String': shape = value => typeof value === 'string'; break;
    case 'Number': shape = value => typeof value === 'number'; break;
    case 'Boolean': shape = value => typeof value === 'boolean'; break;
    case 'Null': shape = value => value === null; break;
    case 'Undefined': shape = value => value === undefined; break;
    case 'Unknown': case 'Any': shape = () => true; break;
    case 'Literal': shape = value => value === ast.literal; break;
    case 'Union': {
      if (ast.mode !== 'anyOf') return undefined;
      const members = ast.types.map(guard);
      if (members.some(member => !member)) return undefined;
      shape = value => members.some(member => member!(value));
      break;
    }
    case 'Arrays': {
      if (ast.elements.length || ast.rest.length !== 1) return undefined;
      const item = guard(ast.rest[0]!);
      if (!item) return undefined;
      shape = value => {
        if (!Array.isArray(value)) return false;
        for (const entry of value) if (!item(entry)) return false;
        return true;
      };
      break;
    }
    case 'Objects': {
      // A decoder may strip extra properties. Only strict objects can safely be
      // returned unchanged after validation instead of copying the whole result.
      if (ast.indexSignatures.length || options.onExcessProperty !== 'error') return undefined;
      const fields = ast.propertySignatures.map(property => ({ key: property.name, optional: !!property.type.context?.isOptional, valid: guard(property.type) }));
      if (fields.some(field => !field.valid)) return undefined;
      const allowed = new Set(fields.map(field => field.key));
      shape = value => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
        const record = value as Record<PropertyKey, unknown>;
        for (const key of Reflect.ownKeys(record)) if (!allowed.has(key)) return false;
        for (const field of fields) {
          if (!Object.hasOwn(record, field.key)) { if (!field.optional) return false; }
          else if (!field.valid!(record[field.key])) return false;
        }
        return true;
      };
      break;
    }
    default: return undefined;
  }
  if (!ast.checks) return shape;
  const passes = (check: SchemaAST.Check<unknown>, value: unknown): boolean => check._tag === 'Filter'
    ? check.run(value, ast, options) === undefined : check.checks.every(item => passes(item, value));
  return value => shape(value) && ast.checks!.every(check => passes(check, value));
}

function decoder(schema: Schema.ConstraintDecoder<unknown>): (value: unknown) => unknown {
  const valid = guard(schema.ast);
  return valid ? (value: unknown) => {
    if (!valid(value)) throw new Error('Invalid boundary value');
    return value;
  } : Schema.decodeUnknownSync(schema);
}
const resultDecoders = Object.fromEntries(Object.entries(resultSchemas).map(([operation, schema]) => [operation, decoder(schema)])) as Record<Operation, (value: unknown) => unknown>;
const payloadDecoders = Object.fromEntries(Object.entries(payloadSchemas).map(([operation, schema]) => [operation, decoder(schema)])) as Record<Operation, (value: unknown) => unknown>;
const requestDecoder = decoder(RequestEnvelopeSchema);

export function decodeResult<O extends Operation>(operation: O, value: unknown): ResultOf<O> {
  return resultDecoders[operation](value) as ResultOf<O>;
}
export function decodePayload<O extends Operation>(operation: O, value: unknown): PayloadOf<O> {
  return payloadDecoders[operation](value) as PayloadOf<O>;
}
export function decodeRequest(value: unknown): RequestEnvelope {
  return requestDecoder(value) as RequestEnvelope;
}
