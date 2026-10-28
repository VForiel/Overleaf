import crypto from 'node:crypto'
import {
  getCollectionInternal,
  ObjectId,
} from '../../../../app/src/infrastructure/mongodb.mjs'

// A connector link is https://<site>/mcp/<token>. Only the SHA-256 of the token is stored.
const PREFIX = 'olmcp_'
const MAX_TOKENS_PER_USER = 20

let collectionPromise
function collection() {
  if (!collectionPromise) {
    collectionPromise = getCollectionInternal('mcpTokens').then(async c => {
      await c.createIndex({ hash: 1 }, { unique: true })
      await c.createIndex({ userId: 1 })
      return c
    })
  }
  return collectionPromise
}

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function looksLikeToken(value) {
  return typeof value === 'string' && /^olmcp_[A-Za-z0-9_-]{32}$/.test(value)
}

async function listForUser(userId) {
  const tokens = await collection()
  return await tokens
    .find({ userId: new ObjectId(userId) }, { projection: { hash: 0 } })
    .sort({ createdAt: -1 })
    .toArray()
}

/** Returns the clear token: it is shown once and cannot be recovered. */
async function create(userId, name) {
  const tokens = await collection()
  const count = await tokens.countDocuments({ userId: new ObjectId(userId) })
  if (count >= MAX_TOKENS_PER_USER) {
    throw new Error('too many connector links')
  }
  const token = PREFIX + crypto.randomBytes(24).toString('base64url')
  await tokens.insertOne({
    userId: new ObjectId(userId),
    name: (name || '').trim().slice(0, 80) || 'Connecteur',
    hash: hash(token),
    createdAt: new Date(),
    lastUsedAt: null,
  })
  return token
}

async function revoke(userId, tokenId) {
  if (!ObjectId.isValid(tokenId)) return
  const tokens = await collection()
  await tokens.deleteOne({
    _id: new ObjectId(tokenId),
    userId: new ObjectId(userId),
  })
}

/** User id owning the token, or null. */
async function findUserId(token) {
  if (!looksLikeToken(token)) return null
  const tokens = await collection()
  const entry = await tokens.findOneAndUpdate(
    { hash: hash(token) },
    { $set: { lastUsedAt: new Date() } },
    { projection: { userId: 1 } }
  )
  return entry ? entry.userId.toString() : null
}

export default { listForUser, create, revoke, findUserId }
