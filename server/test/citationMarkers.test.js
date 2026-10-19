import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCitationMarkers } from '../../client/src/citationMarkers.js';
import { removeTrailingIncompleteCitation } from '../../client/src/streaming.js';

test('citation parser accepts complete grouped and adjacent markers and ignores partial or unknown numbers', () => {
  const validNumbers = new Set([1, 2, 8]);
  const markers = parseCitationMarkers('Here [2, 8][1,3] and [9], but not [2,', validNumbers);
  assert.deepEqual(markers.map(marker => marker.numbers), [[2, 8], [1]]);
  assert.equal(removeTrailingIncompleteCitation('Useful answer [1]. More [2,'), 'Useful answer [1]. More');
});
