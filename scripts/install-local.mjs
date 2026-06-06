import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const pluginRoot = path.join(getTabbyUserDataDir(), 'plugins', 'node_modules')
const pluginDir = path.join(pluginRoot, pkg.name)

const manifest = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  keywords: pkg.keywords,
  main: pkg.main,
  typings: pkg.typings,
  peerDependencies: pkg.peerDependencies,
}

fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true })
fs.rmSync(pluginDir, { recursive: true, force: true })
fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true })

fs.writeFileSync(path.join(pluginDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
copy(path.join(root, 'README.md'), path.join(pluginDir, 'README.md'))
copy(path.join(root, 'dist/index.js'), path.join(pluginDir, 'dist/index.js'))
copy(path.join(root, 'dist/index.d.ts'), path.join(pluginDir, 'dist/index.d.ts'))
copy(path.join(root, 'dist/index.js.map'), path.join(pluginDir, 'dist/index.js.map'))

console.log(`installed ${pkg.name}@${pkg.version} to ${pluginDir}`)

function copy (source, target) {
  fs.copyFileSync(source, target)
}

function getTabbyUserDataDir () {
  if (process.platform === 'darwin') {
    return path.join(home(), 'Library', 'Application Support', 'tabby')
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) {
      throw new Error('APPDATA is not set')
    }
    const lower = path.join(appData, 'tabby')
    const upper = path.join(appData, 'Tabby')
    return fs.existsSync(upper) && !fs.existsSync(lower) ? upper : lower
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'tabby')
}

function home () {
  const value = os.homedir()
  if (!value) {
    throw new Error('home directory is unavailable')
  }
  return value
}
