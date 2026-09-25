import * as fs from 'node:fs'
import * as path from 'node:path'

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024

export function isScreenshotRequest(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase('id-ID')
  if (/^(?:apa|jelaskan|gimana|bagaimana|cara|kenapa|jangan|tidak|nggak)\b/u.test(normalized)) return false
  return /\b(?:screenshot|screen\s*shot|capture\s+(?:screen|layar)|foto layar|tangkap(?:an)? layar)\b/iu.test(normalized)
}

export function prepareScreenshotTarget(rootDir: string, senderKey: string, operationId: string): string {
  if (!/^[a-f0-9]{24}$/u.test(senderKey) || !/^[0-9a-f-]{36}$/iu.test(operationId)) {
    throw new Error('SCREENSHOT_TARGET_INVALID')
  }
  const directory = path.join(rootDir, '.runtime', 'whatsapp-outbound')
  fs.mkdirSync(directory, { recursive: true })
  const root = fs.realpathSync.native(rootDir)
  const actualDirectory = fs.realpathSync.native(directory)
  if (!actualDirectory.startsWith(root + path.sep)) throw new Error('SCREENSHOT_TARGET_INVALID')
  const target = path.join(directory, `${senderKey}-${operationId}.png`)
  if (fs.existsSync(target)) throw new Error('SCREENSHOT_TARGET_EXISTS')
  return target
}

export async function readScreenshot(target: string, rootDir: string): Promise<Buffer> {
  const root = fs.realpathSync.native(rootDir)
  const file = await fs.promises.lstat(target).catch(() => { throw new Error('SCREENSHOT_NOT_AVAILABLE') })
  if (!file.isFile() || file.isSymbolicLink() || file.size < PNG_HEADER.length
    || file.size > MAX_SCREENSHOT_BYTES) throw new Error('SCREENSHOT_INVALID')
  const actual = await fs.promises.realpath(target)
  if (!actual.startsWith(root + path.sep)) throw new Error('SCREENSHOT_INVALID')
  const bytes = await fs.promises.readFile(target)
  if (!bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) throw new Error('SCREENSHOT_INVALID')
  return bytes
}
