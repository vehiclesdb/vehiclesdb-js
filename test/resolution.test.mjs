import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VehiclesDB, normalize } from '../index.mjs'

// Repo root. VDB_CONFORMANCE defaults to a sibling checkout of the public
// dataset repo (github.com/vehiclesdb/vehiclesdb) next to this one.
const root = fileURLToPath(new URL('../', import.meta.url))
const dataPath = path.resolve(process.env.VDB_DATA || path.join(root, 'fixtures/dist/vehicles.json'))
const conformancePath = path.resolve(process.env.VDB_CONFORMANCE || path.join(root, '../vehiclesdb/conformance/resolve.json'))
const source = fs.statSync(dataPath).isDirectory() ? path.join(dataPath, 'dist/vehicles.json') : dataPath
const dist = JSON.parse(fs.readFileSync(source, 'utf8'))
function client(data = dist) {
  return new VehiclesDB({ fetch: async url => {
    assert.ok(url.endsWith('/dist/vehicles.json'), url)
    return new Response(JSON.stringify(data))
  } })
}
const version = s => String(s).split('.').map(Number)
const older = (a, b) => { const x = version(a), y = version(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) }; return false }
const db = client()
test('contract normalization: NFKD, Mn only, lowercase, ASCII', () => {
  for (const [s, expected] of [['Škoda', 'skoda'], ['ﬁ ①', 'fi 1'], ['Straße', 'stra e'], ['丰田', ''], ['a\u034fb', 'ab']]) assert.equal(normalize(s), expected)
})
test('pair ladder, audit trail, cleanup and no stacked guesses', async () => {
  const local = client(JSON.parse(fs.readFileSync(path.join(root, 'fixtures/dist/vehicles.json'), 'utf8')))
  const a = await local.modelMatch('VW', 'Golf')
  assert.equal(a.method, 'fold'); assert.equal(a.confidence, .97)
  assert.deepEqual((await local.modelMatch('トヨタ', 'カローラ')).via, ['alias:カローラ→corolla'])
  assert.deepEqual(a.via, ['make_alias:vw→volkswagen'])
  const b = await local.modelMatch('Volkswagon', 'Golf')
  assert.equal(b.method, 'fuzzy'); assert.equal(b.confidence, .8)
  assert.deepEqual(b.via, ['make_typo:volkswagon→volkswagen'])
  const c = await local.modelMatch('VW', 'Nuevo Volkswagen Golf', { kind: 'car' })
  assert.equal(c.method, 'cleaned'); assert.equal(c.confidence, .9)
  assert.deepEqual(c.via, ['kind_hint:car', 'make_alias:vw→volkswagen', 'filler:nuevo', 'make_echo:volkswagen'])
  assert.equal(await local.modelMatch('Volkswagon', 'Gollf'), null)
  assert.equal(await local.modelMatch('VW', 'Volkswagen'), null)
  assert.equal(await local.modelMatch('VW', 'golf-extra'), null)
  assert.equal(await local.resolve('VW Golf 1.9 TDI'), null)
  assert.equal(await local.resolve('golf'), null)
  assert.equal(await local.resolve('VW+ Gollf'), null)
  const typo = await local.modelMatch('VW', 'Gollf')
  assert.equal(typo.method, 'fuzzy'); assert.deepEqual(typo.via, ['make_alias:vw→volkswagen', 'model_typo:gollf→golf'])
})
test('ambiguity stops each rung; kinds are variants; digit and machine guards', async () => {
  const data = { version: '1', kinds: ['van', 'car'], makes: [{ name: 'Example', slug: 'example', aliases: ['Ex'], models: [
    { name: 'Alpha', slug: 'alpha', kind: 'car', aliases: ['Shared', 'One Two'], forms: ['Registry', 'Echo'] },
    { name: 'Alphi', slug: 'alphi', kind: 'car', aliases: ['Shared', 'On E Two'], forms: ['Registry', 'E c h o'] },
    { name: 'A B', slug: 'a-b', kind: 'car' }, { name: 'AB', slug: 'ab', kind: 'car' },
    { name: 'A BC', slug: 'a-bc', kind: 'car' }, { name: 'AB C', slug: 'ab-c', kind: 'car' },
    { name: 'Twin Name', slug: 'twin-one', kind: 'car' }, { name: 'Twin Name', slug: 'twin-two', kind: 'car' },
    { name: 'Alpha Z', slug: 'alpha-z', kind: 'car' }, { name: 'Alpha Foo Bar', slug: 'alpha-foo-bar', kind: 'car' },
    { name: 'Alpha', slug: 'alpha', kind: 'van', global_decile: 1 },
    { name: '2008', slug: '2008', kind: 'car' }
  ] }] }
  const local = client(data)
  for (const [q, rung] of [['Shared', 'alias'], ['One T wo', 'alias'], ['Registry', 'form'], ['Ech o', 'form'], ['A B C', 'fold'], ['TwinName', 'fold'], ['Alphu', 'fuzzy'], ['New Registry', 'form']]) {
    const r = await local.modelMatch('Example', q)
    assert.equal(r.ambiguous, true, q); assert.equal(r.match, null); assert.ok(r.alternates.length >= 2)
    assert.equal(r.method, rung); assert.equal(r.confidence, 0)
  }
  assert.equal((await local.modelMatch('Example', 'a b')).id, 'car/example/a-b')
  assert.equal((await local.modelMatch('Example', 'Alpha')).kind, 'van')
  assert.equal((await local.modelMatch('Example', 'Alpha', {kind:'car'})).kind, 'car')
  for (const q of ['208', 'alpha_typo', 'alpha/typo', 'alpha+typo', 'alpha\\typo', 'alphu-slug', 'ALPHU-SLUG']) assert.equal(await local.modelMatch('Example', q), null, q)
  assert.equal((await local.resolve('Shared')).ambiguous, true)
  assert.equal(await local.modelMatch('Example', 'New alpha-z'), null)
  assert.equal(await local.resolve('exampel alpha-z'), null)
  assert.equal(await local.resolve('Example Alpah foo-bar'), null)
  assert.equal((await local.resolve('Example Alpah Foo-Bar')).method, 'fuzzy')
  assert.equal((await local.resolve('Example alpha-z')).id, 'car/example/alpha-z')
})
test('forms from supplied release are make-scoped and outrank cleanup/typos', { skip: !process.env.VDB_DATA && 'set VDB_DATA to the dist with forms' }, async () => {
  for (const [make, model, id, method] of [
    ['Peugeot', '2008 Allure', 'car/peugeot/2008', 'form'],
    ['Opel', 'Insigna', 'car/opel/insignia', 'form'],
    ['VW', 'Toureg', 'car/volkswagen/touareg', 'form'],
    ['Citroen', 'Nuevo Citroën C3 Aircr', 'car/citroen/c3-aircross', 'form'],
    ['Kia', 'XCeed', 'car/kia/x-ceed', 'fold'],
    ['BMW', 'Serie 3', 'car/bmw/3-series', 'fold'],
    ['Mercedes', 'c class', 'car/mercedes-benz/c-class', 'fold']
  ]) {
    for (const r of [await db.modelMatch(make, model, {kind:'car'}), await db.resolve(`${make} ${model}`, {kind:'car'})]) {
      assert.equal(r?.id, id); assert.equal(r.method, method)
    }
  }
  assert.equal(await db.modelMatch('Toyota', '2008 Allure'), null)
  assert.equal(await db.resolve('2008 Allure'), null)
})
test('published resolution conformance', { skip: !fs.existsSync(conformancePath) && `absent: ${conformancePath}` }, async t => {
  const data = JSON.parse(fs.readFileSync(conformancePath, 'utf8'))
  for (const [i, c] of (Array.isArray(data) ? data : data.cases).entries()) await t.test(`${i}: ${c.input || c.make + ' | ' + c.model}`, {skip: c.min_dataset && older(dist.version, c.min_dataset) ? `needs dataset ${c.min_dataset}` : false}, async () => {
    const r = c.entry === 'pair' ? await db.modelMatch(c.make, c.model, {kind:c.kind, kinds:c.kinds}) : await db.resolve(c.input, {kind:c.kind, kinds:c.kinds})
    if (c.expect === 'ambiguous') { assert.equal(r?.ambiguous, true); assert.equal(r.match, null); assert.ok(r.alternates.length > 1) }
    else if (c.expect === null) assert.equal(r, null)
    else { assert.equal(r?.id, c.expect); assert.equal(r.ambiguous, false) }
    if (c.method) assert.equal(r?.method, c.method)
  })
})

test('complete make echoes, protected fillers, curated spacing, make typo ties', async () => {
  const data = {version:'1', kinds:['car'], makes:[
    {name:'A & B', slug:'a-b', models:[
      {name:'Alpha', slug:'alpha', kind:'car', aliases:['Space'], forms:['Registry/Alpha']},
      {name:'Nova', slug:'nova', kind:'car'}, {name:'SS', slug:'ss', kind:'car'}
    ]},
    ...['Acma', 'Acura'].map(name=>({name, slug:name.toLowerCase(), models:[{name:'Alpha', slug:'alpha', kind:'car'}]}))
  ]}
  const local = client(data)
  const echo = await local.modelMatch('A & B', 'A And B Alpha')
  assert.equal(echo.method, 'cleaned'); assert.deepEqual(echo.via, ['make_echo:a and b'])
  assert.equal(await local.modelMatch('A & B', 'B Alpha'), null)
  assert.equal(await local.modelMatch('A & B', 'Nova SS'), null)
  assert.equal((await local.modelMatch('A & B', 'Sp a ce')).method, 'alias')
  assert.equal((await local.modelMatch('A & B', 'Registry/Alpha')).method, 'form')
  assert.equal(await local.modelMatch('Acra', 'Alpha'), null)
  const cap = await local.modelMatch('Acurra', 'Space')
  assert.equal(cap, null) // only A & B owns that alias
  assert.equal((await local.modelMatch('Acurra', 'Alpha')).method, 'fuzzy')
})

test('make typos use whole-string distance and unique makes', async () => {
  const makes = ['De Lorean', 'Acma', 'Acura', 'Car AB8', 'Bus Ab'].map(name => ({
    name, slug: name.toLowerCase().replace(' ', '-'), models: [{name: 'Alpha', slug: 'alpha', kind: 'car'}]
  }))
  const local = client({version: '1', kinds: ['car'], makes})
  for (const [make, id] of [['delorean', 'de-lorean'], ['car ab9', 'car-ab8'], ['bus ac', 'bus-ab']]) {
    const result = await local.modelMatch(make, 'Alpha')
    assert.equal(result.id, `car/${id}/alpha`)
    assert.equal(result.method, 'fuzzy')
  }
  assert.equal(await local.modelMatch('acra', 'Alpha'), null)
  assert.equal(await local.resolve('acra alpha'), null)
  assert.equal(await local.modelMatch('delorean extra', 'Alpha'), null)
})

test('text matcher uses exact-first splits, name guard, record-level aliases and id trails', async () => {
  const local = client({version: '1', kinds: ['car', 'van'], makes: [
    {name:'Land', slug:'land', models:[{name:'Rover Defender', slug:'rover-defender', kind:'car'},
      {name:'Rovar Alpha', slug:'rovar-alpha', kind:'car'}]},
    {name:'Land Rover', slug:'land-rover', models:[{name:'Defender', slug:'defender', kind:'car'}]},
    {name:'Example', slug:'example', models:[
      {name:'Alpha', slug:'alpha', kind:'car', aliases:['Shared', 'Alpha'], former_ids:['car/example/old', 'car/example/collision']},
      {name:'Alpha', slug:'alpha', kind:'van', aliases:['Shared']},
      {name:'Beta', slug:'beta', kind:'car', aliases:['Collision'], former_ids:['car/example/collision']}
    ]},
    {name:'Other', slug:'other', models:[{name:'Collision', slug:'collision', kind:'car'},
      {name:'Gamma', slug:'gamma', kind:'car', aliases:['Ambiguous']}]},
    {name:'Third', slug:'third', models:[{name:'Delta', slug:'delta', kind:'car', aliases:['Ambiguous']}]}
  ]})
  assert.equal((await local.resolve('land rover defender')).id, 'car/land-rover/defender')
  assert.equal((await local.resolve('land rovar alpha')).id, 'car/land/rovar-alpha')
  assert.equal((await local.resolve('alpha')).id, 'car/example/alpha')
  assert.equal(await local.resolve('collision'), null)
  assert.equal((await local.resolve('ambiguous')).ambiguous, true)
  const alias = await local.resolve('shared', {kind:'van'})
  assert.equal(alias.id, 'van/example/alpha')
  assert.deepEqual(alias.via, ['kind_hint:van', 'alias:shared→example/alpha'])
  assert.deepEqual((await local.resolve('car/example/alpha')).via, ['exact:car/example/alpha'])
  assert.deepEqual((await local.resolve('car/example/old')).via, ['former_id:car/example/old'])
  assert.equal((await local.resolve('car/example/collision', {kind:'van'})).ambiguous, true)
  assert.equal(await local.resolve('example+ alphi'), null)
})

test('kind collisions: one tie-break (RESOLUTION §3a), kinds is a hard filter, confident', async () => {
  const data = { version: '1', kinds: ['bus', 'car', 'moped', 'motorcycle', 'truck', 'van'], makes: [
    { name: 'Iveco', slug: 'iveco', models: [
      { name: 'Daily', slug: 'daily', kind: 'bus', global_decile: 2, mass_decile: 1, forms: ['Turbo', 'Turbodaily'] },
      { name: 'Daily', slug: 'daily', kind: 'truck', global_decile: 1, mass_decile: 1, forms: ['Turbo', 'Turbodaily'] },
      { name: 'Daily', slug: 'daily', kind: 'van', global_decile: 3, mass_decile: 1, forms: ['Turbodaily'], former_ids: ['van/iveco/35s'] }
    ] },
    { name: 'Mercedes-Benz', slug: 'mercedes-benz', models: [
      { name: 'V-Class', slug: 'v-class', kind: 'car', mass_decile: 1 },
      { name: 'V-Class', slug: 'v-class', kind: 'van', global_decile: 1, mass_decile: 2 }
    ] },
    { name: 'Toyota', slug: 'toyota', models: [
      { name: 'Corolla', slug: 'corolla', kind: 'car' }, { name: 'Corona', slug: 'corona', kind: 'car' }
    ] }
  ] }
  const local = client(data)
  // Unhinted: mass_decile ties → van, never the car-first or global_decile answer.
  for (const r of [await local.resolve('iveco daily'), await local.modelMatch('Iveco', 'Daily')]) {
    assert.equal(r.id, 'van/iveco/daily'); assert.equal(r.ambiguous, false); assert.equal(r.method, 'fold')
    assert.deepEqual(r.alternates.map(m => m.kind).sort(), ['bus', 'truck'])
  }
  assert.equal((await local.modelMatch('Mercedes-Benz', 'V-Class')).id, 'car/mercedes-benz/v-class')
  // Forms: only the records that carry the form compete (never widened).
  assert.equal((await local.modelMatch('Iveco', 'Turbodaily')).id, 'van/iveco/daily')
  assert.equal((await local.modelMatch('Iveco', 'Turbo')).id, 'bus/iveco/daily')
  // A typo tie between kinds of one nameplate is a collision, not ambiguity.
  const typo = await local.modelMatch('Iveco', 'Dialy')
  assert.equal(typo.id, 'van/iveco/daily'); assert.equal(typo.method, 'fuzzy'); assert.equal(typo.confident, false)
  assert.equal((await local.modelMatch('Toyota', 'Corola')).ambiguous, true)
  // kind scopes the name rungs; kinds constrains every rung.
  assert.equal((await local.resolve('iveco daily', { kind: 'truck' })).id, 'truck/iveco/daily')
  assert.equal((await local.resolve('iveco daily', { kinds: ['truck', 'bus'] })).id, 'bus/iveco/daily')
  assert.equal(await local.resolve('iveco daily', { kinds: [] }), null)
  assert.equal(await local.resolve('bus/iveco/daily', { kinds: ['car'] }), null)
  assert.equal((await local.resolve('bus/iveco/daily', { kind: 'car' })).id, 'bus/iveco/daily')
  assert.equal((await local.resolve('iveco daily')).confident, true)
  // Id helpers.
  assert.equal((await local.byId('van/iveco/35s')).id, 'van/iveco/daily')
  assert.equal(await local.byId('van/iveco/35s', { follow: false }), null)
  assert.equal(await local.byId('van/iveco/daily', { kinds: ['car'] }), null)
  assert.equal(await local.successor('VAN/iveco/35s'), 'van/iveco/daily')
  assert.equal(await local.successor('bus/iveco/daily'), 'bus/iveco/daily')
  assert.equal(await local.successor('car/nope/nope'), null)
})

test('make former slugs land on the successor make', async () => {
  const local = client({ version: '1', kinds: ['truck'], makes: [
    { name: 'Renault', slug: 'renault', kinds: ['truck'], former_slugs: ['renault-trucks'], models: [{ name: 'Master', slug: 'master', kind: 'truck' }] }
  ] })
  const r = await local.modelMatch('Renault Trucks', 'Master')
  assert.equal(r.id, 'truck/renault/master')
  assert.ok(r.via.includes('former_make_slug:renault trucks→renault'))
  assert.equal((await local.models('renault-trucks')).length, 1)
})
