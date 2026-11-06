import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import SafePath from '../../../../app/src/Features/Project/SafePath.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import LockManager from '../../../../app/src/infrastructure/LockManager.mjs'
import { git, GitError, explainRemoteError } from './GitCommand.mjs'
import { flush, latestVersion } from './GitBridgeSnapshots.mjs'
import { currentFiles, deleteFiles, writeFile } from './ProjectFiles.mjs'
import * as Store from './GitSyncStore.mjs'

// Sync of a project with one branch of a remote repository (GitHub, GitLab…),
// driven by the Pull and Push buttons of the editor.
//
// Each linked project has a bare repository on the server. Its ref "sync" is the
// last state that the project and the branch had in common. A pull or a push
// first records the current project as a commit on top of "sync", then:
//   pull: merges the branch into it (or takes the branch as it is), and writes
//         the files that changed into the project;
//   push: sends that commit to the branch, if the branch has nothing new.
// No working tree: git only reads and writes objects, so a repository cannot
// plant files (symlinks, hooks) on the server.

const SOURCE = 'git-sync'
const SYNC_REF = 'refs/heads/sync'
const MAX_FILE_SIZE = 50 * 1024 * 1024
const NETWORK_TIMEOUT = 3 * 60 * 1000
const lock = LockManager.withTimeout(10 * 60)


export class SyncError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.details = details
  }
}

// ------------------------------------------------------------ validation

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/i

/** https URL of a repository, without credentials, or a SyncError. */
export function checkUrl(value) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw new SyncError('Adresse invalide : colle l’adresse https du dépôt.')
  }
  if (url.protocol !== 'https:') {
    throw new SyncError('Seules les adresses https sont acceptées.')
  }
  if (url.username || url.password) {
    throw new SyncError(
      'Mets le jeton dans le champ prévu, pas dans l’adresse.'
    )
  }
  if (PRIVATE_HOST.test(url.hostname) || !url.hostname.includes('.')) {
    throw new SyncError('Ce serveur n’est pas accepté.')
  }
  url.hash = ''
  url.search = ''
  return url.toString()
}

export function checkBranch(value) {
  const branch = String(value || '').trim()
  if (
    !branch ||
    branch.length > 200 ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    /^[-/.]|\/$|\.\.|\/\/|\.lock$|@\{/.test(branch)
  ) {
    throw new SyncError('Nom de branche invalide.')
  }
  return branch
}

// ------------------------------------------------------------ repository

function repoDir(projectId) {
  const root = Settings.gitSyncDir || '/var/lib/overleaf/data/git-sync'
  return Path.join(root, `${projectId}.git`)
}

async function ensureRepo(projectId) {
  const dir = repoDir(projectId)
  if (!fs.existsSync(Path.join(dir, 'HEAD'))) {
    await fs.promises.mkdir(dir, { recursive: true })
    await git(dir, ['init', '--bare', '--quiet', '--initial-branch=sync'])
  }
  return dir
}

async function removeRepo(projectId) {
  await fs.promises.rm(repoDir(projectId), { recursive: true, force: true })
}

async function resolve(dir, ref) {
  const { stdout, code } = await git(
    dir,
    ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    { okCodes: [0, 1] }
  )
  return code === 0 ? stdout.trim() : null
}

async function treeOf(dir, commit) {
  const { stdout } = await git(dir, ['rev-parse', `${commit}^{tree}`])
  return stdout.trim()
}

async function isAncestor(dir, ancestor, descendant) {
  const { code } = await git(
    dir,
    ['merge-base', '--is-ancestor', ancestor, descendant],
    { okCodes: [0, 1] }
  )
  return code === 0
}

/** Branches of the remote repository: { branches, defaultBranch }. */
export async function listBranches(url, token) {
  const tmp = await fs.promises.mkdtemp(Path.join(os.tmpdir(), 'git-sync-'))
  try {
    const { stdout } = await git(
      tmp,
      ['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*'],
      { token, timeout: NETWORK_TIMEOUT }
    )
    const branches = []
    let defaultBranch = null
    for (const line of stdout.split('\n')) {
      const symref = line.match(/^ref: refs\/heads\/(.+)\tHEAD$/)
      if (symref) defaultBranch = symref[1]
      const head = line.match(/^[0-9a-f]{40}\trefs\/heads\/(.+)$/)
      if (head) branches.push(head[1])
    }
    return { branches: branches.sort(), defaultBranch }
  } catch (err) {
    if (err instanceof GitError) throw new SyncError(explainRemoteError(err))
    throw err
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true })
  }
}

/** Fetches the branch; its commit, or null if the branch does not exist. */
async function fetchBranch(dir, url, token, branch) {
  try {
    await git(
      dir,
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        url,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      { token, timeout: NETWORK_TIMEOUT }
    )
  } catch (err) {
    if (err instanceof GitError && /couldn't find remote ref/i.test(err.stderr)) {
      await git(dir, ['update-ref', '-d', `refs/remotes/origin/${branch}`], {
        okCodes: [0, 1],
      })
      return null
    }
    if (err instanceof GitError) throw new SyncError(explainRemoteError(err))
    throw err
  }
  return await resolve(dir, `refs/remotes/origin/${branch}`)
}

// ---------------------------------------------- project <-> git objects

async function authorOf(userId) {
  const user = await UserGetter.promises.getUser(userId, {
    email: 1,
    first_name: 1,
    last_name: 1,
  })
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ')
  return { name: name || user?.email || 'Overleaf', email: user?.email || '' }
}

async function readStream(stream, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > limit) throw new SyncError('Fichier trop gros (plus de 50 Mo).')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Records a set of files as a commit on top of parent (or as a first commit).
 * files: { path: { content } | { hash, bytes? } }, as in a history snapshot.
 * Returns parent itself when the tree did not change.
 */
async function commitFiles(dir, files, parent, author, message, loadBlob) {
  const entries = [] // [mode, sha, path]
  const texts = []
  for (const [path, file] of Object.entries(files)) {
    if (path.split('/').includes('.git')) continue
    if (typeof file.content === 'string') {
      texts.push([path, file.content])
    } else if (file.hash) {
      const { code } = await git(dir, ['cat-file', '-e', file.hash], {
        okCodes: [0, 1, 128],
      })
      if (code !== 0) {
        const bytes = await loadBlob(file.hash)
        await git(dir, ['hash-object', '-w', '--stdin'], { input: bytes })
      }
      entries.push(['100644', file.hash, path])
    }
  }

  // Text files: one git process for all of them
  if (texts.length > 0) {
    const tmp = await fs.promises.mkdtemp(Path.join(os.tmpdir(), 'git-sync-'))
    try {
      const paths = []
      for (const [i, [, content]] of texts.entries()) {
        const fsPath = Path.join(tmp, String(i))
        await fs.promises.writeFile(fsPath, content, 'utf8')
        paths.push(fsPath)
      }
      const { stdout } = await git(
        dir,
        ['hash-object', '-w', '--no-filters', '--stdin-paths'],
        { input: paths.join('\n') + '\n' }
      )
      stdout
        .trim()
        .split('\n')
        .forEach((sha, i) => entries.push(['100644', sha, texts[i][0]]))
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true })
    }
  }

  const index = Path.join(
    dir,
    `sync-index-${crypto.randomBytes(6).toString('hex')}`
  )
  let tree
  try {
    const env = { GIT_INDEX_FILE: index }
    await git(dir, ['read-tree', '--empty'], { env })
    const info = entries
      .map(([mode, sha, path]) => `${mode} ${sha}\t${path}\0`)
      .join('')
    await git(dir, ['update-index', '--add', '-z', '--index-info'], {
      env,
      input: info,
    })
    tree = (await git(dir, ['write-tree'], { env })).stdout.trim()
  } finally {
    await fs.promises.rm(index, { force: true })
  }

  if (parent && (await treeOf(dir, parent)) === tree) return parent
  const args = ['commit-tree', tree, '-m', message]
  if (parent) args.push('-p', parent)
  return (await git(dir, args, { author })).stdout.trim()
}

/** The current project as a commit on top of parent (see commitFiles). */
async function commitProject(dir, projectId, parent, author, message) {
  await flush(projectId)
  const { version } = await latestVersion(projectId)
  const snapshot = await HistoryManager.promises.getContentAtVersion(
    projectId,
    version
  )
  return await commitFiles(
    dir,
    snapshot.files || {},
    parent,
    author,
    message,
    async hash => {
      const { stream } =
        await HistoryManager.promises.requestBlobWithProjectId(projectId, hash)
      return await readStream(stream, MAX_FILE_SIZE)
    }
  )
}

/** Merge commit (or null on conflict, with the conflicting paths). */
async function merge(dir, ours, theirs, author, message) {
  const { stdout, code } = await git(
    dir,
    [
      'merge-tree',
      '--write-tree',
      '--allow-unrelated-histories',
      '--name-only',
      '-z',
      ours,
      theirs,
    ],
    { okCodes: [0, 1] }
  )
  const parts = stdout.split('\0')
  if (code === 1) {
    const conflicts = []
    for (const part of parts.slice(1)) {
      if (!part) break
      conflicts.push(part)
    }
    return { commit: null, conflicts: [...new Set(conflicts)] }
  }
  const tree = parts[0].trim()
  const { stdout: commit } = await git(
    dir,
    ['commit-tree', tree, '-p', ours, '-p', theirs, '-m', message],
    { author }
  )
  return { commit: commit.trim(), conflicts: [] }
}

/** Files that differ between two trees: [{ mode, sha, status, path }]. */
async function treeChanges(dir, fromTree, toTree) {
  const { stdout } = await git(dir, [
    'diff-tree',
    '-r',
    '-z',
    '--no-renames',
    '--raw',
    fromTree,
    toTree,
  ])
  const fields = stdout.split('\0')
  const changes = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i].match(/^:(\d+) (\d+) [0-9a-f]+ ([0-9a-f]+) (\w)/)
    if (meta) {
      changes.push({
        mode: meta[2],
        sha: meta[3],
        status: meta[4],
        path: fields[i + 1],
      })
    }
  }
  return changes
}

/** Writes into the project what changed between two trees. */
async function applyTrees(dir, projectId, userId, fromTree, toTree) {
  const changes = await treeChanges(dir, fromTree, toTree)
  const existing = await currentFiles(projectId)
  const skipped = []
  const deleted = []
  let written = 0
  const tmp = await fs.promises.mkdtemp(Path.join(os.tmpdir(), 'git-sync-'))
  try {
    for (const change of changes) {
      if (change.status === 'D') {
        if (existing.has(change.path)) deleted.push(change.path)
        continue
      }
      if (!['100644', '100755'].includes(change.mode)) {
        skipped.push(`${change.path} (lien ou sous-module)`)
        continue
      }
      if (!SafePath.isCleanPath(change.path)) {
        skipped.push(`${change.path} (nom refusé par Overleaf)`)
        continue
      }
      const { stdout: size } = await git(dir, ['cat-file', '-s', change.sha])
      if (Number(size) > MAX_FILE_SIZE) {
        skipped.push(`${change.path} (plus de 50 Mo)`)
        continue
      }
      const { stdout: bytes } = await git(
        dir,
        ['cat-file', 'blob', change.sha],
        { output: 'buffer' }
      )
      const fsPath = Path.join(tmp, 'file')
      await fs.promises.writeFile(fsPath, bytes)
      await writeFile(
        projectId,
        userId,
        change.path,
        fsPath,
        existing.get(change.path) || null,
        SOURCE
      )
      written++
    }
    if (deleted.length > 0) {
      const { stdout: kept } = await git(dir, [
        'ls-tree',
        '-r',
        '-z',
        '--name-only',
        toTree,
      ])
      await deleteFiles(
        projectId,
        userId,
        deleted,
        kept.split('\0').filter(Boolean),
        SOURCE
      )
    }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true })
  }
  return { written, deleted: deleted.length, skipped }
}

// ------------------------------------------------------------ operations

async function withLink(projectId, fn) {
  const link = await Store.getLink(projectId)
  if (!link) throw new SyncError('Ce projet n’est relié à aucun dépôt.')
  return await lock.promises.runWithLock('git-sync', projectId, async () => {
    const dir = await ensureRepo(projectId)
    const token = await Store.decryptToken(link)
    return await fn({ link, dir, token })
  })
}

/** Links the project (owner only). Keeps the sync state if the URL does not change. */
export async function link(projectId, userId, { url, branch, token }) {
  url = checkUrl(url)
  branch = checkBranch(branch)
  const previous = await Store.getLink(projectId)
  const sameRepo = previous && previous.url === url
  if (!token && sameRepo) token = await Store.decryptToken(previous)
  token = token ? String(token).trim() : null
  await listBranches(url, token) // checks address and access
  await lock.promises.runWithLock('git-sync', projectId, async () => {
    if (!sameRepo) await removeRepo(projectId)
    await Store.saveLink(projectId, userId, { url, branch, token })
  })
}

export async function unlink(projectId) {
  await lock.promises.runWithLock('git-sync', projectId, async () => {
    await Store.deleteLink(projectId)
    await removeRepo(projectId)
  })
}

export async function changeBranch(projectId, branch) {
  branch = checkBranch(branch)
  if (!(await Store.getLink(projectId))) {
    throw new SyncError('Ce projet n’est relié à aucun dépôt.')
  }
  await Store.setBranch(projectId, branch)
}

/**
 * Brings the branch into the project.
 * strategy "merge": git merge (refused on conflict, nothing is changed);
 * strategy "replace": the project becomes exactly the branch.
 */
export async function pull(projectId, userId, { strategy = 'merge' } = {}) {
  return await withLink(projectId, async ({ link, dir, token }) => {
    const { branch } = link
    const remote = await fetchBranch(dir, link.url, token, branch)
    if (!remote) {
      throw new SyncError(`La branche « ${branch} » n’existe pas sur le dépôt.`)
    }
    const author = await authorOf(userId)
    const sync = await resolve(dir, SYNC_REF)
    const ours = await commitProject(
      dir,
      projectId,
      sync,
      author,
      'État du projet Overleaf avant le pull'
    )

    let target
    if (strategy === 'replace') {
      target =
        ours === remote
          ? remote
          : (
              await git(
                dir,
                [
                  'commit-tree',
                  await treeOf(dir, remote),
                  '-p',
                  ours,
                  '-p',
                  remote,
                  '-m',
                  `Projet remplacé par la branche ${branch}`,
                ],
                { author }
              )
            ).stdout.trim()
    } else if (await isAncestor(dir, remote, ours)) {
      return { message: 'Déjà à jour : la branche n’a rien de nouveau.' }
    } else if (await isAncestor(dir, ours, remote)) {
      target = remote
    } else {
      const merged = await merge(
        dir,
        ours,
        remote,
        author,
        `Fusion de la branche ${branch} dans Overleaf`
      )
      if (!merged.commit) {
        throw new SyncError(
          'Conflit : ces fichiers ont changé des deux côtés. Rien n’a été modifié.',
          { conflicts: merged.conflicts }
        )
      }
      target = merged.commit
    }

    const result = await applyTrees(
      dir,
      projectId,
      userId,
      await treeOf(dir, ours),
      await treeOf(dir, target)
    )
    await git(dir, ['update-ref', SYNC_REF, target])
    await Store.recordSync(projectId, userId, {
      direction: 'pull',
      commit: target,
    })
    const parts = [`${result.written} fichier(s) mis à jour`]
    if (result.deleted) parts.push(`${result.deleted} supprimé(s)`)
    return {
      message: `Pull terminé : ${parts.join(', ')}.`,
      skipped: result.skipped,
      commit: target,
    }
  })
}

/** Sends the project to the branch, as a commit with the given message. */
export async function push(projectId, userId, { message } = {}) {
  return await withLink(projectId, async ({ link, dir, token }) => {
    const { branch } = link
    const remote = await fetchBranch(dir, link.url, token, branch)
    const sync = await resolve(dir, SYNC_REF)
    if (remote && !sync) {
      throw new SyncError(
        `La branche « ${branch} » a déjà du contenu : fais d’abord un pull (fusion ou remplacement), ou pousse sur une nouvelle branche.`
      )
    }
    const author = await authorOf(userId)
    const text = String(message || '').trim().slice(0, 2000)
    const ours = await commitProject(
      dir,
      projectId,
      sync,
      author,
      text || 'Mise à jour depuis Overleaf'
    )
    if (remote) {
      if (ours === remote) {
        return { message: 'Rien à envoyer : la branche est déjà à jour.' }
      }
      if (!(await isAncestor(dir, remote, ours))) {
        throw new SyncError(
          'La branche a des commits que le projet n’a pas encore : fais d’abord un pull.'
        )
      }
    }
    try {
      await git(
        dir,
        ['push', '--quiet', link.url, `${ours}:refs/heads/${branch}`],
        { token, timeout: NETWORK_TIMEOUT }
      )
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      if (/rejected|non-fast-forward|fetch first/i.test(err.stderr)) {
        throw new SyncError(
          'La branche a changé entre-temps : fais d’abord un pull.'
        )
      }
      throw new SyncError(explainRemoteError(err))
    }
    await git(dir, ['update-ref', SYNC_REF, ours])
    await Store.recordSync(projectId, userId, {
      direction: 'push',
      commit: ours,
    })
    logger.debug({ projectId, branch }, 'git-sync: pushed')
    return {
      message: remote
        ? `Push terminé sur « ${branch} ».`
        : `Branche « ${branch} » créée sur le dépôt.`,
      commit: ours,
    }
  })
}

/** What the editor panel shows. */
export async function status(projectId) {
  const link = await Store.getLink(projectId)
  if (!link) return { linked: false }
  let lastSync = null
  if (link.lastSync) {
    const user = await UserGetter.promises.getUser(link.lastSync.by, {
      first_name: 1,
      last_name: 1,
      email: 1,
    })
    lastSync = {
      direction: link.lastSync.direction,
      commit: link.lastSync.commit,
      at: link.lastSync.at,
      by: user
        ? [user.first_name, user.last_name].filter(Boolean).join(' ') ||
          user.email
        : null,
    }
  }
  return {
    linked: true,
    url: link.url,
    branch: link.branch,
    hasToken: Boolean(link.encryptedToken),
    lastSync,
  }
}

// For the tests only (local "remote" repositories over file://)
export const _internals = {
  ensureRepo,
  resolve,
  treeOf,
  isAncestor,
  fetchBranch,
  commitFiles,
  merge,
  treeChanges,
}
