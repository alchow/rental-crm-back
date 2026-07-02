// injectSchemaHygiene spec (comms build, post-review regression guard).
//
// The pass repairs three zod-to-openapi emission artifacts (nullable enums
// missing null, junk allOf wrappers, duplicate null members). The load-bearing
// invariant — and the one a prior version broke — is that it must fix a schema
// WITHOUT mutating any object shared by reference: zod-openapi emits one enum
// array object shared across every position that reuses a z.enum, so an
// in-place push onto one nullable position would corrupt every non-nullable
// sibling. This spec drives that shared-reference case directly.

import { describe, expect, it } from 'vitest';
import { injectSchemaHygiene } from '../src/openapi/idempotency-contract';

describe('injectSchemaHygiene', () => {
  it('adds null to a nullable enum without corrupting a non-nullable sibling that shares the array', () => {
    // The exact shape zod-openapi emits: ONE enum array object referenced by
    // both a plain-string field and a nullable field.
    const sharedEnum = ['queued', 'sent', 'delivered'];
    const doc = {
      components: {
        schemas: {
          Outbox: { type: 'object', properties: { status: { type: 'string', enum: sharedEnum } } },
          Message: {
            type: 'object',
            properties: { delivery_status: { type: ['string', 'null'], enum: sharedEnum } },
          },
        },
      },
    };
    injectSchemaHygiene(doc);
    const outboxEnum = doc.components.schemas.Outbox.properties.status.enum;
    const deliveryEnum = doc.components.schemas.Message.properties.delivery_status.enum;
    // The non-nullable, plain-string field must NOT gain null.
    expect(outboxEnum).toEqual(['queued', 'sent', 'delivered']);
    expect(outboxEnum).not.toContain(null);
    // The nullable field's enum must gain null.
    expect(deliveryEnum).toContain(null);
    // And the two must no longer be the same array object.
    expect(outboxEnum).not.toBe(deliveryEnum);
  });

  it('adds null to a genuinely nullable enum', () => {
    const doc = { x: { type: ['string', 'null'], enum: ['a', 'b'] } };
    injectSchemaHygiene(doc);
    expect(doc.x.enum).toEqual(['a', 'b', null]);
  });

  it('leaves a non-nullable enum untouched', () => {
    const doc = { x: { type: 'string', enum: ['a', 'b'] } };
    injectSchemaHygiene(doc);
    expect(doc.x.enum).toEqual(['a', 'b']);
  });

  it('collapses allOf [$ref, {type:object}] to a plain $ref', () => {
    const doc = { x: { allOf: [{ $ref: '#/c/QH' }, { type: 'object' }] } };
    injectSchemaHygiene(doc);
    expect(doc.x).toEqual({ $ref: '#/c/QH' });
  });

  it('collapses allOf [$ref, {type:[object,null]}] to anyOf [$ref, null]', () => {
    const doc = { x: { allOf: [{ $ref: '#/c/QH' }, { type: ['object', 'null'] } ] } };
    injectSchemaHygiene(doc);
    expect(doc.x).toEqual({ anyOf: [{ $ref: '#/c/QH' }, { type: 'null' }] });
  });

  it('preserves a genuine allOf composition (extend pattern) with a real object member', () => {
    const doc = {
      x: { allOf: [{ $ref: '#/c/Base' }, { type: 'object', properties: { extra: { type: 'string' } } }] },
    };
    const before = JSON.parse(JSON.stringify(doc));
    injectSchemaHygiene(doc);
    expect(doc).toEqual(before);
  });

  it('dedupes duplicate {type:null} members inside anyOf', () => {
    const doc = { x: { anyOf: [{ $ref: '#/c/QH' }, { type: 'null' }, { type: 'null' }] } };
    injectSchemaHygiene(doc);
    expect(doc.x.anyOf).toEqual([{ $ref: '#/c/QH' }, { type: 'null' }]);
  });

  it('is idempotent', () => {
    const doc = {
      a: { type: ['string', 'null'], enum: ['x'] },
      b: { allOf: [{ $ref: '#/c/QH' }, { type: 'object' }] },
      c: { anyOf: [{ $ref: '#/c/QH' }, { type: 'null' }, { type: 'null' }] },
    };
    injectSchemaHygiene(doc);
    const once = JSON.parse(JSON.stringify(doc));
    injectSchemaHygiene(doc);
    expect(doc).toEqual(once);
  });
});
