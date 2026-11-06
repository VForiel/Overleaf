import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import AccessTokenEncryptor from '@overleaf/access-token-encryptor'
import {
  getCollectionInternal,
  ObjectId,
} from '../../../../app/src/infrastructure/mongodb.mjs'

// Link between a project and a branch of a remote repository (collection
// gitSyncLinks, one per project). The access token is encrypted; it never
// leaves the server once saved.

const CIPHER_LABEL = 'gitsync.1-v3'

let encryptor
function getEncryptor() {
  if (!encryptor) {
    const secret =
      process.env.OVERLEAF_INVITE_TOKEN_SECRET || Settings.security.sessionSecret
    const password = crypto
      .createHmac('sha256', secret)
      .update('git-sync access tokens')
      .digest('hex')
    encryptor = new AccessTokenEncryptor({
      cipherLabel: CIPHER_LABEL,
      cipherPasswords: { [CIPHER_LABEL]: password },
    })
  }
  return encryptor
}

let collectionPromise
function collection() {
  if (!collectionPromise) {
    collectionPromise = getCollectionInternal('gitSyncLinks').then(async c => {
      await c.createIndex({ projectId: 1 }, { unique: true })
      return c
    })
  }
  return collectionPromise
}

export async function getLink(projectId) {
  const links = await collection()
  return await links.findOne({ projectId: new ObjectId(projectId) })
}

export async function decryptToken(link) {
  if (!link?.encryptedToken) return null
  const { token } = await getEncryptor().promises.decryptToJson(
    link.encryptedToken
  )
  return token
}

export async function saveLink(projectId, userId, { url, branch, token }) {
  const links = await collection()
  const encryptedToken = token
    ? await getEncryptor().promises.encryptJson({ token })
    : null
  await links.updateOne(
    { projectId: new ObjectId(projectId) },
    {
      $set: {
        url,
        branch,
        encryptedToken,
        linkedBy: new ObjectId(userId),
        linkedAt: new Date(),
      },
      $unset: { lastSync: '' },
    },
    { upsert: true }
  )
}

export async function setBranch(projectId, branch) {
  const links = await collection()
  await links.updateOne(
    { projectId: new ObjectId(projectId) },
    { $set: { branch } }
  )
}

export async function recordSync(projectId, userId, { direction, commit }) {
  const links = await collection()
  await links.updateOne(
    { projectId: new ObjectId(projectId) },
    {
      $set: {
        lastSync: {
          direction,
          commit,
          at: new Date(),
          by: new ObjectId(userId),
        },
      },
    }
  )
}

export async function deleteLink(projectId) {
  const links = await collection()
  await links.deleteOne({ projectId: new ObjectId(projectId) })
}
