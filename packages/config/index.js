'use strict'

const { basename, join, resolve, dirname } = require('path')
const { readFile, access } = require('fs/promises')
const EventEmitter = require('events')
const Ajv = require('ajv')
const fastifyPlugin = require('./lib/plugin')
const dotenv = require('dotenv')
const { FileWatcher } = require('@platformatic/utils')
const { getParser, analyze } = require('@platformatic/metaconfig')

class ConfigManager extends EventEmitter {
  constructor (opts) {
    super()
    this.pupa = null
    this.envWhitelist = opts.envWhitelist || []
    if (!opts.source) {
      throw new Error('Source missing.')
    }

    this.validationErrors = []
    if (typeof opts.source === 'string') {
      this.fullPath = resolve(opts.source)
      const allowToWatch = opts.allowToWatch || []
      allowToWatch.push(basename(this.fullPath))
      this._parser = getParser(this.fullPath)

      this.fileWatcher = new FileWatcher({
        path: dirname(this.fullPath),
        allowToWatch
      })

      /* c8 ignore next 3 */
      if (opts.watch) {
        this.startWatching()
      }
      this.dirname = dirname(this.fullPath)
    } else {
      this.current = opts.source
      this.dirname = opts.dirname || process.cwd()
    }

    this.schema = opts.schema || {}
    this.schemaOptions = opts.schemaOptions || {}
    this._originalEnv = opts.env || {}
    this.env = this.purgeEnv(this._originalEnv)
  }

  toFastifyPlugin () {
    return async (app, opts) => {
      return fastifyPlugin(app, {
        ...opts,
        configManager: this
      })
    }
  }

  async stopWatching () {
    await this.fileWatcher.stopWatching()
  }

  startWatching () {
    if (this.fileWatcher.isWatching) return

    this.fileWatcher.on('update', async () => {
      try {
        await this.parseAndValidate()
        this.emit('update', this.current)
      } catch (err) {
        this.emit('error', err)
      }
    })
    this.fileWatcher.startWatching()
  }

  purgeEnv (providedEnvironment) {
    const env = {
      ...process.env,
      ...providedEnvironment
    }
    const purged = {}
    for (const key in env) {
      if (key.match(/^PLT_/) || this.envWhitelist.includes(key)) {
        purged[key] = env[key]
      }
    }
    return purged
  }

  async replaceEnv (configString) {
    if (this.pupa === null) {
      this.pupa = (await import('pupa')).default
    }
    const paths = [
      join(dirname(this.fullPath), '.env'),
      join(process.cwd(), '.env')
    ]
    let dotEnvPath
    for (const p of paths) {
      try {
        await access(p)
        dotEnvPath = p
        break
      } catch {
        // Nothing to do
      }
    }
    let env = { ...this._originalEnv }
    if (dotEnvPath) {
      const data = await readFile(dotEnvPath, 'utf-8')
      const parsed = dotenv.parse(data)
      env = { ...env, ...parsed }
    }
    this.env = this.purgeEnv(env)

    const escapeJSONstring = ({ value }) => {
      if (!value) return value
      // TODO this shoudl handle all the escapes chars
      // defined in https://www.json.org/json-en.html
      // but it's good enough for now.
      return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
    }

    return this.pupa(configString, this.env, { transform: escapeJSONstring })
  }

  _transformConfig () {}

  async parse () {
    try {
      if (this.fullPath) {
        const configString = await this.load()
        this.current = this._parser(await this.replaceEnv(configString))
        // try updating the config format to latest
        try {
          let meta = await analyze({ config: this.current })
          while (typeof meta.up === 'function') {
            meta = meta.up()
          }
          this.current = meta.config
        } catch {
          // nothing to do
        }
      }
      const validationResult = this.validate()
      if (!validationResult) {
        return false
      }
      await this._transformConfig()
      return true
    } catch (err) {
      if (err.name === 'MissingValueError') {
        if (!err.key.match(/^PLT_/) && !this.envWhitelist.includes(err.key)) {
          throw new Error(`${err.key} is an invalid placeholder. All placeholders must be prefixed with PLT_.\nDid you mean PLT_${err.key}?`)
        } else {
          throw new Error(`${err.key} env variable is missing.`)
        }
      }
      const newerr = new Error(`Cannot parse config file. ${err.message}`)
      newerr.cause = err
      throw newerr
    }
  }

  validate () {
    if (!this.current) {
      return false
    }
    const ajv = new Ajv(this.schemaOptions)
    ajv.addKeyword({
      keyword: 'resolvePath',
      type: 'string',
      schemaType: 'boolean',
      // TODO: figure out how to implement this via the new `code`
      // option in Ajv
      validate: (schema, path, parentSchema, data) => {
        const resolved = resolve(this.dirname, path)
        data.parentData[data.parentDataProperty] = resolved
        return true
      }
    })
    const ajvValidate = ajv.compile(this.schema)

    const res = ajvValidate(this.current)
    /* c8 ignore next 12 */
    if (!res) {
      this.validationErrors = ajvValidate.errors.map((err) => {
        return {
          path: err.instancePath === '' ? '/' : err.instancePath,
          message: err.message + ' ' + JSON.stringify(err.params)
        }
      })
      return false
    }
    return true
  }

  async parseAndValidate () {
    const validationResult = await this.parse()
    if (!validationResult) {
      throw new Error(this.validationErrors.map((err) => {
        return err.message
      }).join('\n'))
    }
  }

  async update (newConfig) {
    const _old = { ...this.current }
    this.current = newConfig
    if (!this.validate()) {
      this.current = _old
      return false
    }
    await this._transformConfig()
    this.emit('update', this.current)
    return true
  }

  async load () {
    const configString = await readFile(this.fullPath, 'utf-8')
    return configString
  }
}

module.exports = ConfigManager
