import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGeneration, validateColdStartDecode } from '../src/middleware/validation.js';

test('generation validation accepts an optional binding', () => {
    assert.equal(validateGeneration({}), undefined);
    assert.equal(validateGeneration({ content_binding: 'video-id' }), undefined);
    assert.equal(validateGeneration({ content_binding: 42 }), 'content_binding must be a non-empty string when provided');
});

test('cold-start decode validation requires a token', () => {
    assert.equal(validateColdStartDecode({}), 'token must be a non-empty string');
    assert.equal(validateColdStartDecode({ token: 'token' }), undefined);
});
