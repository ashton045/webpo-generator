import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGeneration, validateColdStartDecode } from '../src/middleware/validation.js';
import { parse_json } from '../src/utils/helpers.js';

test('generation validation accepts an optional binding', () => {
    assert.equal(validateGeneration({}), undefined);
    assert.equal(validateGeneration({ content_binding: 'video-id' }), undefined);
    assert.equal(validateGeneration({ content_binding: 42 }), 'content_binding must be a non-empty string when provided');
});

test('cold-start decode validation requires a token', () => {
    assert.equal(validateColdStartDecode({}), 'token must be a non-empty string');
    assert.equal(validateColdStartDecode({ token: 'token' }), undefined);
});

test('handles commas and quotes', () => {
    const input = "{'a': 1, 'b': 2, }";
    const parsed = parse_json(input);
    assert.deepEqual(parsed, { a: 1, b: 2 });
});

test('decodes hex escapes json', () => {
    const input = '{"title": "Song \\x22Remix\\x22 by \\x41\\x42", "nested": "{\\"count\\": 42}"}';
    const parsed = parse_json(input);
    assert.deepEqual(parsed, {
        title: 'Song "Remix" by AB',
        nested: { count: 42 }
    });
});

test('supports arrays and unquoted keys', () => {
    const input = '{ unquoted: ["\\x31", "\\x32"], "name": "test", }';
    const parsed = parse_json(input);
    assert.deepEqual(parsed, {
        unquoted: ["1", "2"],
        name: 'test'
    });
});
