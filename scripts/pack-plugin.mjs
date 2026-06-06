import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const releaseDir = path.join(root, 'release')
const packageName = pkg.name
const zipPath = path.join(releaseDir, `${packageName}-${pkg.version}.zip`)
const crcTable = createCrcTable()

const files = [
  { source: path.join(root, 'README.md'), target: `${packageName}/README.md` },
  { source: path.join(root, 'dist/index.js'), target: `${packageName}/dist/index.js` },
  { source: path.join(root, 'dist/index.d.ts'), target: `${packageName}/dist/index.d.ts` },
  { source: path.join(root, 'dist/index.js.map'), target: `${packageName}/dist/index.js.map` },
]

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

fs.rmSync(releaseDir, { recursive: true, force: true })
fs.mkdirSync(releaseDir, { recursive: true })

const entries = [
  directoryEntry(`${packageName}/`),
  directoryEntry(`${packageName}/dist/`),
  fileEntry(`${packageName}/package.json`, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)),
  ...files.map(file => fileEntry(file.target, fs.readFileSync(file.source))),
]

fs.writeFileSync(zipPath, buildZip(entries))
console.log(`created ${path.relative(root, zipPath)}`)

function directoryEntry (name) {
  return { name, data: Buffer.alloc(0), isDirectory: true }
}

function fileEntry (name, data) {
  return { name, data, isDirectory: false }
}

function buildZip (entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const compressed = entry.isDirectory ? Buffer.alloc(0) : zlib.deflateRawSync(data)
    const crc = crc32(data)
    const method = entry.isDirectory ? 0 : 8
    const { time, date } = dosDateTime(new Date())

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(time, 10)
    localHeader.writeUInt16LE(date, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, name, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(date, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(entry.isDirectory ? 0x10 : 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, name)

    offset += localHeader.length + name.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, end])
}

function dosDateTime (date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosYear = Math.max(1980, date.getFullYear()) - 1980
  const dosDate = (dosYear << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: dosDate }
}

function createCrcTable () {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
}

function crc32 (buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
