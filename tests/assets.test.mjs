import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const root = new URL('../public/', import.meta.url);
test('shipped GLB assets contain every runtime-required mesh and valid buffer ranges', async () => {
  const required = {
    cabin: ['Cabin','DoorL','DoorR','Display','DisplayOut','Lights','Buttons'],
    arch: ['Column','BridgeSeg','Slab','Monolith','Landing','Gate'],
    stepwell: ['StepwellModule','StepwellCap','StepwellLamps'],
  };
  for (const [file, names] of Object.entries(required)) {
    const bytes = await readFile(new URL(`models/${file}.glb`, root));
    assert.equal(bytes.readUInt32LE(0), 0x46546c67);
    assert.equal(bytes.readUInt32LE(4), 2);
    assert.equal(bytes.readUInt32LE(8), bytes.length);
    const jsonSize = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.toString('utf8',20,20+jsonSize));
    for (const name of names) {
      const node = gltf.nodes.find(n => n.name === name);
      assert.ok(node && gltf.meshes[node.mesh], `${file}: ${name}`);
      for (const primitive of gltf.meshes[node.mesh].primitives) {
        const positions = gltf.accessors[primitive.attributes.POSITION];
        assert.ok(positions.count > 0);
        assert.ok([...positions.min, ...positions.max].every(Number.isFinite));
      }
    }
    for (const view of gltf.bufferViews) assert.ok((view.byteOffset ?? 0) + view.byteLength <= gltf.buffers[view.buffer].byteLength);
  }
});

test('audio manifest and required media reference existing assets with valid loop bounds', async () => {
  const manifest = JSON.parse(await readFile(new URL('audio/manifest.json', root), 'utf8'));
  for (const zone of ['hall','canyon','stepwell','summit']) {
    const bed = manifest.beds[zone];
    assert.ok(bed.gain >= 0 && Number.isFinite(bed.gain));
    assert.ok(bed.loopStart >= 0 && bed.loopEnd > bed.loopStart);
    await access(new URL(`audio/${bed.file}`, root));
  }
  for (const path of ['video/intro.mp4','audio/sfx/bottom.m4a','audio/sfx/stop.m4a','textures/stone_detail.jpg','textures/stone_normal.jpg']) {
    assert.ok((await readFile(new URL(path, root))).length > 0, path);
  }
});
