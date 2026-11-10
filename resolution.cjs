'use strict'

// RESOLUTION.md: published evidence first; heuristics never override ambiguity.
const CONFIDENCE = { exact: 1, former_id: .98, fold: .97, alias: .93, form: .92, cleaned: .90, fuzzy: .80 }
const FILLERS = new Set('nuevo nueva new neu neue nouveau nouvelle nuovo nuova novo nova'.split(' '))
const rawKey = s => String(s ?? '').trim().toLowerCase()
const unique = xs => [...new Map(xs.map(x => [x.id, x])).values()]
// RESOLUTION.md §3a: `kinds` is a hard constraint on every rung; [] = nothing.
const inKinds = (options, model) => options.kinds == null ||
  (Array.isArray(options.kinds) ? options.kinds : [options.kinds]).includes(model.kind)
const eligible = raw => {
  const s = String(raw ?? '').trim()
  return s.split(/\s+/).every(token => !(/[/_+\\]/.test(token) || /^-|-$|--/.test(token) || /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(token) || /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(token)))
}

// Optimal string alignment, including adjacent transposition, as in Fuzzy.distance.
function distance(a, b, limit) {
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      let n = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (prev2 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) n = Math.min(n, prev2[j - 2] + 1)
      cur.push(n)
    }
    if (Math.min(...cur) > limit && Math.min(...prev) > limit) return limit + 1
    prev2 = prev; prev = cur
  }
  return Math.min(prev[b.length], limit + 1)
}
function wordDistance(query, key) {
  if (query.length < 4) return null
  const limit = query.length >= 6 ? 2 : 1
  if (Math.abs(query.length - key.length) > limit) return null
  const words = query.split(' '), others = key.split(' ')
  if (words.length !== others.length) return null
  let total = 0
  for (let i = 0; i < words.length; i++) {
    const a = words[i], b = others[i]
    if (a === b) continue
    if (a[0] !== b[0] || /[0-9]/.test(a + b) || Math.min(a.length, b.length) < 4) return null
    const budget = a.length >= 9 ? 2 : 1
    const d = distance(a, b, budget)
    total += d
    if (d > budget || total > limit) return null
  }
  return total || null
}

class Resolver {
  constructor(index, norm, pick) {
    this.index = index; this.norm = norm; this.pick = xs => pick(index, xs)
    this.makeKeys = []; this.scopes = new Map()
    this.names = new Map(); this.aliases = new Map()
    for (const make of index.makes) {
      for (const s of [make.name, make.slug, ...make.aliases]) {
        const key = norm(s)
        if (key) this.makeKeys.push([key, make])
      }
      this.scopes.set(make.slug, (index.modelsByMakeSlug.get(make.slug) || []).map(model => ({
        model, name: norm(model.name), slug: norm(model.slug),
        aliases: model.aliases.map(norm).filter(Boolean), forms: model.forms.map(norm).filter(Boolean)
      })))
      for (const entry of this.scopes.get(make.slug)) {
        if (!this.names.has(entry.name)) this.names.set(entry.name, new Set())
        this.names.get(entry.name).add(`${entry.model.makeId}/${entry.model.slug}`)
        for (const alias of entry.aliases) {
          if (!this.aliases.has(alias)) this.aliases.set(alias, [])
          this.aliases.get(alias).push(entry.model)
        }
      }
    }
  }
  result(hits, method, via, { ambiguous = false, confidence = CONFIDENCE[method], selected = null } = {}) {
    hits = unique(hits)
    const model = ambiguous ? null : selected || this.pick(hits)
    if (!model && !ambiguous) return null
    const score = ambiguous ? 0 : confidence
    const match = model ? Object.freeze({ id: model.id, name: model.name,
      make: Object.freeze({ id: model.makeId, name: model.makeName }), kind: model.kind, confidence: score, method }) : null
    const candidates = Object.freeze(hits)
    const trail = Object.freeze(via.slice())
    return Object.freeze({ id: model?.id ?? null, kind: model?.kind ?? null, make: model?.makeName ?? null,
      model: model?.name ?? null, method, matchedOn: method, confidence: score, source: 'dataset',
      // Safe to auto-apply to stored data: an answer, from curated data or a
      // conservative cleanup — not a typo guess, not ambiguous.
      confident: !ambiguous && method !== 'fuzzy',
      match, ambiguous, candidates, alternates: Object.freeze(hits.filter(x => x.id !== model?.id)),
      via: trail, resolvedVia: trail })
  }
  make(raw, fuzzy = true) {
    const q = this.norm(raw), key = rawKey(raw)
    let make = this.index.makes.find(m => q && [m.name, m.slug].some(s => this.norm(s) === q))
    if (make) return { make, via: [], typo: false }
    make = q && this.index.makes.find(m => m.formerSlugs.some(f => this.norm(f) === q))
    if (make) return { make, via: [`former_make_slug:${q}→${make.slug}`], typo: false }
    make = this.index.makes.find(m => m.aliases.some(a => q ? this.norm(a) === q : key && rawKey(a) === key))
    if (make) return { make, via: q ? [`make_alias:${q}→${make.slug}`] : [], typo: false }
    if (!fuzzy || !eligible(raw) || q.length < 4) return null
    const limit = q.length >= 6 ? 2 : 1
    const words = q.split(' ')
    let best = Infinity, hits = new Map()
    for (const [k, m] of this.makeKeys) {
      const other = k.split(' ')
      if (Math.abs(q.length - k.length) > limit || other.length < words.length) continue
      if (other.length === words.length ? words.some((w, i) => w[0] !== other[i][0]) : words[0][0] !== other[0][0]) continue
      const d = distance(q, k, limit)
      if (d > limit || d > best) continue
      if (d < best) { best = d; hits = new Map() }
      hits.set(m.slug, m)
    }
    if (hits.size !== 1) return null
    make = [...hits.values()][0]
    return { make, via: [`make_typo:${q}→${make.slug}`], typo: true }
  }
  scope(make, options) {
    return this.scopes.get(make.slug).filter(e => (!options.kind || e.model.kind === options.kind) && inKinds(options, e.model) &&
      (!options.country || e.model.availability.includes(rawKey(options.country))))
  }
  rungs(entries, query, via, cap) {
    const sq = query.replace(/ /g, '')
    let hits = entries.filter(e => e.name === query || e.slug === query)
    let transformed = false, ambiguous = false
    if (!hits.length) {
      hits = entries.filter(e => e.name.replace(/ /g, '') === sq)
      transformed = true
      ambiguous = new Set(hits.map(e => e.model.slug)).size > 1
    }
    if (!hits.length && /^serie \w+$/.test(query)) {
      const series = query.replace(/^serie (\w+)$/, '$1 series')
      hits = entries.filter(e => e.name === series || e.slug === series)
      if (!hits.length) {
        hits = entries.filter(e => e.name.replace(/ /g, '') === series.replace(/ /g, ''))
        ambiguous = new Set(hits.map(e => e.model.slug)).size > 1
      }
      transformed = true
    }
    if (hits.length) {
      const models = hits.map(e => e.model), model = this.pick(models)
      return this.result(models, ambiguous ? 'fold' : cap || 'fold',
        via.concat(ambiguous ? [`fold:${query}`] : transformed ? [`fold:${query}→${model.slug}`] : []), { ambiguous })
    }
    for (const [field, method] of [['aliases', 'alias'], ['forms', 'form']]) {
      hits = entries.filter(e => e[field].includes(query))
      if (!hits.length) hits = entries.filter(e => e[field].some(s => s.replace(/ /g, '') === sq))
      if (!hits.length) continue
      const models = hits.map(e => e.model)
      ambiguous = new Set(models.map(m => m.slug)).size > 1
      return this.result(models, ambiguous ? method : cap || method,
        via.concat(`${method}:${query}${ambiguous ? '' : '→' + this.pick(models).slug}`), { ambiguous })
    }
    return null
  }
  ladder(resolved, raw, options = {}, heuristics = true, makeQuery = '') {
    const { make, typo } = resolved
    const via = (options.kind ? [`kind_hint:${options.kind}`] : []).concat(resolved.via)
    const entries = this.scope(make, options)
    let query = this.norm(raw)
    if (!query) {
      const hits = entries.filter(e => e.model.aliases.some(a => rawKey(a) === rawKey(raw) && rawKey(raw))).map(e => e.model)
      if (!hits.length) return null
      const ambiguous = new Set(hits.map(m => m.slug)).size > 1
      return this.result(hits, typo && !ambiguous ? 'fuzzy' : 'alias', via.concat(`alias:${String(raw).trim()}${ambiguous ? '' : '→' + this.pick(hits).slug}`), { ambiguous })
    }
    const exact = this.rungs(entries, query, via, typo ? 'fuzzy' : null)
    if (exact || !heuristics || !eligible(raw)) return exact
    const all = this.scopes.get(make.slug)
    const modelWord = key => all.some(e => e.name === key || e.slug === key || e.aliases.includes(key))
    let names = [make.name, make.slug, ...make.aliases, ...(!typo ? [makeQuery] : [])]
    names = names.concat(names.filter(n => n.includes('&')).map(n => n.replace(/&/g, ' and ')))
    const echoes = [...new Set(names.map(this.norm).filter(Boolean))].sort((a, b) => b.split(' ').length - a.split(' ').length)
    const steps = []
    while (query) {
      const head = query.split(' ')[0]
      let peel = null, step
      if (FILLERS.has(head) && !modelWord(head)) { peel = head; step = `filler:${head}` }
      else {
        peel = echoes.find(e => (query === e || query.startsWith(e + ' ')) && !modelWord(e))
        step = `make_echo:${peel}`
      }
      if (!peel) break
      query = query.slice(peel.length).trim(); steps.push(step)
      if (!query) return null
      const retried = this.rungs(entries, query, via.concat(steps), typo ? 'fuzzy' : 'cleaned')
      if (retried) return retried
    }
    if (typo) return null
    const best = new Map()
    for (const e of entries) for (const key of [e.name, ...e.aliases, ...e.forms]) {
      const d = wordDistance(query, key)
      if (d === null) continue
      const old = best.get(e.model.slug)
      if (!old || d < old.d) best.set(e.model.slug, { d, key, models: [e.model] })
      else if (d === old.d) old.models.push(e.model)
    }
    const ranked = [...best.values()].sort((a, b) => a.d - b.d)
    if (!ranked.length) return null
    const top = ranked.filter(r => r.d === ranked[0].d), ambiguous = top.length > 1
    return this.result(top.flatMap(r => r.models), 'fuzzy', via.concat(steps, `model_typo:${query}${ambiguous ? '' : '→' + top[0].key}`), { ambiguous })
  }
  pair(make, model, options = {}) {
    const resolved = this.make(make)
    if (!resolved) return null
    return this.ladder(resolved, model, options, true, make)
  }
  text(raw, options = {}) {
    raw = String(raw ?? '').trim()
    if (!raw) return null
    const allowed = m => (!options.kind || m.kind === options.kind) && inKinds(options, m) &&
      (!options.country || m.availability.includes(rawKey(options.country)))
    const hint = options.kind ? [`kind_hint:${options.kind}`] : []
    const byId = (hits, method) => {
      hits = hits.filter(m => inKinds(options, m) && (!options.country || m.availability.includes(rawKey(options.country))))
      if (!hits.length) return null
      const via = hint.concat(`${method}:${raw}`)
      if (new Set(hits.map(m => `${m.makeId}/${m.slug}`)).size > 1) return this.result(hits, method, via, { ambiguous: true })
      const preferred = options.kind ? hits.filter(m => m.kind === options.kind) : []
      return this.result(hits, method, via, { selected: this.pick(preferred.length ? preferred : hits) })
    }
    const exact = this.index.modelById.get(raw)
    const idResult = byId(exact ? [exact] : [], 'exact') ||
      byId((this.index.modelsByFormerId.get(rawKey(raw)) || []).filter(m => m.formerIds.includes(raw)), 'former_id')
    if (idResult) return idResult
    const q = this.norm(raw)
    if (!q) return null
    const tokens = q.split(' ')
    let split = null
    for (const fuzzy of (eligible(raw) ? [false, true] : [false])) {
      for (let i = tokens.length - (fuzzy ? 1 : 0); i > 0; i--) {
        const makeQuery = tokens.slice(0, i).join(' '), model = tokens.slice(i).join(' ')
        const resolved = this.make(makeQuery, fuzzy)
        if (!resolved) continue
        split = { resolved, model, makeQuery }; break
      }
      if (split) break
    }
    if (split && split.model) {
      const found = this.rungs(this.scope(split.resolved.make, options), split.model,
        hint.concat(split.resolved.via), split.resolved.typo ? 'fuzzy' : null)
      if (found) return found
    }
    const hits = (this.aliases.get(q) || []).filter(allowed)
    if (hits.length) {
      const records = new Set(hits.map(m => `${m.makeId}/${m.slug}`))
      const named = this.names.get(q) || new Set()
      if (![...named].some(record => !records.has(record))) {
        if (records.size > 1) return this.result(hits, 'alias', hint.concat(`alias:${q}`), { ambiguous: true })
        const model = this.pick(hits)
        return this.result(hits, 'alias', hint.concat(`alias:${q}→${model.makeId}/${model.slug}`), { confidence: .90 })
      }
    }
    if (!split || !split.model || !eligible(raw)) return null
    return this.ladder(split.resolved, split.model, options, true, split.makeQuery)
  }
}
module.exports = { Resolver }
