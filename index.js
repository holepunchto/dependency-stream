const parse = require('sloppy-module-parser')
const resolve = require('drive-resolve')
const b4a = require('b4a')
const { Readable } = require('streamx')

module.exports = class DependencyStream extends Readable {
  constructor (drive, {
    entrypoint = '.',
    preload = true,
    source = false,
    strict = false,
    builtins = [],
    runtimes = ['bare', 'node'],
    conditions = runtimes
  } = {}) {
    super({ highWaterMark: 64 * 1024, byteLength: objectByteLength })

    this.drive = drive
    this.entrypoint = entrypoint
    this.preload = preload
    this.source = source
    this.modules = new Map()
    this.strict = strict
    this.builtins = Array.isArray(builtins) ? new Set(builtins) : builtins

    this._importConditions = ['module', 'import', ...conditions]
    this._requireConditions = ['require', ...conditions]
    this._pending = new Map()
    this._stack = []
  }

  async _open (cb) {
    try {
      await parse.init()
      const key = await resolve(this.drive, this.entrypoint, { basedir: '/', conditions: this.conditions })
      this._stack.push(key)
    } catch (err) {
      return cb(err)
    }

    cb(null)
  }

  async _read (cb) {
    if (this._stack.length === 0) {
      this.push(null)
      return
    }

    try {
      while (this._stack.length > 0) {
        const key = this._stack.pop()
        if (this.modules.has(key)) continue
        const data = await this._addOnce(key)
        this.modules.set(key, data)
        if (this.push(data) === false) break
      }
    } catch (err) {
      return cb(err)
    }

    cb(null)
  }

  async _addOnce (key) {
    if (this._pending.has(key)) return this._pending.get(key)

    const p = this._add(key)
    this._pending.set(key, p)
    await p
    this._pending.delete(key)

    return p
  }

  async _add (key) {
    const data = await this.drive.get(key)
    if (data === null) throw new Error('Key not found: ' + key)

    const source = b4a.toString(data)
    const type = key.endsWith('.json') ? 'json' : key.endsWith('.mjs') ? 'module' : 'script'
    const deps = parse.parse(source, type, type !== 'script')

    const result = {
      key,
      source: this.source ? source : null,
      type: deps.type,
      resolutions: deps.resolutions,
      namedImports: deps.namedImports,
      exports: deps.exports
    }

    const basedir = key.slice(0, key.lastIndexOf('/'))
    const all = []

    for (let i = 0; i < result.resolutions.length; i++) {
      const res = result.resolutions[i]
      if (res.input === null) continue

      const conditions = res.isImport ? this._importConditions : this._requireConditions
      all.push(resolve(this.drive, res.input, { basedir, conditions }))
    }

    const outputs = await Promise.allSettled(all)

    for (let i = 0; i < result.resolutions.length; i++) {
      const res = result.resolutions[i]
      if (res.input === null) continue

      const { value, reason } = outputs[i]

      if (reason) {
        if (!this.strict) continue
        throw reason
      }

      res.output = value
      if (!this.modules.has(res.output)) {
        if (this.preload) this._addOnce(res.output).catch(noop)
        this._stack.push(res.output)
      }
    }

    return result
  }
}

function noop () {}

function objectByteLength () {
  return 1024
}
