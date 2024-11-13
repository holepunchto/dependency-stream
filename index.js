const parse = require('sloppy-module-parser')
const b4a = require('b4a')
const resolve = require('bare-module-resolve')
const FIFO = require('fast-fifo')
const runtime = require('which-runtime')
const { Readable } = require('streamx')

module.exports = class DependencyStream extends Readable {
  constructor (drive, {
    entrypoint = '.',
    preload = true,
    source = false,
    strict = false,
    packages = false,
    builtins = [],
    runtimes = ['bare', 'node'],
    extensions = ['.js', '.cjs', '.json', '.mjs'],
    host = runtime.platform + '-' + runtime.arch,
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
    this.packages = packages
    this.extensions = extensions
    this.host = host

    this._importConditions = ['module', 'import', ...conditions]
    this._requireConditions = ['require', ...conditions]
    this._pending = new Map()
    this._packages = new Map()
    this._queue = new FIFO()
  }

  async _open (cb) {
    try {
      const entrypoint = /^[./]/.test(this.entrypoint) ? this.entrypoint : './' + this.entrypoint
      await parse.init()
      const pkg = await this._readPackageCached('/package.json')
      const key = await this._resolveModule(entrypoint, '/', (!!pkg && pkg.type === 'module'))
      this._queue.push(key)
    } catch (err) {
      return cb(err)
    }

    cb(null)
  }

  _readPackageCached (key) {
    let p = this._packages.get(key)
    if (p) return p
    p = this._readPackage(key)
    this._packages.set(key, p)
    return p
  }

  async _readPackage (key) {
    const buf = await this.drive.get(key)
    if (!buf) return null
    try {
      return JSON.parse(b4a.toString(buf))
    } catch {
      return null
    }
  }

  async _resolvePackage (key) {
    const basedir = key.slice(0, key.lastIndexOf('/') + 1)

    for (const url of resolve.lookupPackageScope(toFileURL(basedir))) {
      const k = fromFileURL(url)
      const pkg = await this._readPackageCached(k)
      if (!pkg) continue
      return { key: k, package: pkg }
    }

    return null
  }

  async _resolvePrebuild (key) {
    const pkg = await this._readPackageCached(key + '/package.json')
    if (!pkg) throw new Error('Addon requires a package.json')

    const name = pkg.name.replace(/\//g, '+')
    const tries = [
      key + '/prebuilds/' + this.host + '/' + name + '@' + pkg.version + '.node',
      key + '/prebuilds/' + this.host + '/' + name + '@' + pkg.version + '.bare',
      key + '/prebuilds/' + this.host + '/' + name + '.node',
      key + '/prebuilds/' + this.host + '/' + name + '.bare',
      '/prebuilds/' + this.host + '/' + name + '@' + pkg.version + '.node',
      '/prebuilds/' + this.host + '/' + name + '@' + pkg.version + '.bare',
      '/prebuilds/' + this.host + '/' + name + '.node',
      '/prebuilds/' + this.host + '/' + name + '.bare'
    ]

    for (const key of tries) {
      const e = await this.drive.entry(key)
      if (e) return key
    }

    const err = new Error(`Cannot find addon '${key}'`)
    err.code = 'ADDON_NOT_FOUND'
    throw err
  }

  async _resolveModule (id, basedir, isImport) {
    const conditions = isImport ? this._importConditions : this._requireConditions

    const readPackage = (packageURL) => this._readPackageCached(fromFileURL(packageURL))
    const parentURL = toFileURL(basedir)

    for await (const moduleURL of resolve(id, parentURL, { extensions: this.extensions, conditions }, readPackage)) {
      const key = fromFileURL(moduleURL)
      if (await this.drive.entry(key)) return key
    }

    const err = new Error(`Cannot find module '${id}'`)
    err.code = 'MODULE_NOT_FOUND'
    throw err
  }

  async _read (cb) {
    try {
      while (this._queue.length > 0) {
        const key = this._queue.shift()
        if (this.modules.has(key)) continue
        const data = await this._addOnce(key)
        this.modules.set(key, data)
        this._pending.delete(key)
        if (this.push(data) === false) break
      }
    } catch (err) {
      return cb(err)
    }

    if (this._queue.length === 0) {
      this.push(null)
      return cb(null)
    }
    cb(null)
  }

  async _addOnce (key) {
    if (this._pending.has(key)) return this._pending.get(key)
    const p = this._add(key)
    this._pending.set(key, p)
    await p
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
      exports: deps.exports,
      addons: deps.addons,
      assets: deps.assets
    }

    if (this.packages && type !== 'json') {
      const p = await this._resolvePackage(key)
      if (p) {
        result.resolutions.push({
          isImport: deps.type === 'module',
          position: null,
          input: 'bare:package',
          output: p.key
        })
      }
    }

    const basedir = key.slice(0, key.lastIndexOf('/') + 1)
    const all = []

    for (const res of result.resolutions) {
      if (isAddonPolyfill(res.input)) {
        result.addons.push({
          input: '.',
          output: null
        })
      }
    }

    for (const dep of result.addons) {
      dep.input = fromFileURL(toFileURL(basedir + dep.input))
      if (dep.input.endsWith('/')) dep.input = dep.input.slice(0, -1)
      all.push(this._resolvePrebuild(dep.input))
    }

    for (const res of result.resolutions) {
      if (res.input === null) continue
      all.push(res.output || this._resolveModule(res.input, basedir, res.isImport))
    }

    const outputs = await Promise.allSettled(all)
    let p = 0

    for (const dep of result.addons) {
      const { value, reason } = outputs[p++]

      if (reason) {
        if (!this.strict) continue
        throw reason
      }

      dep.output = value
    }

    for (const res of result.resolutions) {
      if (res.input === null) continue

      const { value, reason } = outputs[p++]

      if (reason) {
        if (!this.strict) continue
        throw reason
      }

      res.output = value
      if (!this.modules.has(res.output)) {
        if (this.preload) this._addOnce(res.output).catch(noop)
        this._queue.push(res.output)
      }
    }

    return result
  }
}

function noop () {}

function objectByteLength () {
  return 1024
}

function toFileURL (path) {
  return new URL('file://' + encodeURI(path))
}

function fromFileURL (url) {
  return decodeURI(url.pathname)
}

function isAddonPolyfill (name) {
  // node-gyp-build is our old one, and require-addon is the only we moved to
  return name === 'node-gyp-build' || name === 'require-addon'
}
