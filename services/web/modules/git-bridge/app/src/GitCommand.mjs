import { spawn } from 'node:child_process'

// Runs the git binary of the image for the sync with remote repositories.
// No shell, no system or user configuration, HTTPS only, never a prompt. The
// access token goes in an HTTP header through the environment: it is never
// written in a URL, a config file or a command line.

export class GitError extends Error {
  constructor(message, { stderr = '', code = null } = {}) {
    super(message)
    this.stderr = stderr
    this.code = code
  }
}

function environment({ token, author } = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: '/nonexistent',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Tests use local repositories over file://
    GIT_ALLOW_PROTOCOL: process.env.GIT_SYNC_TEST_PROTOCOLS || 'https',
    GIT_CONFIG_COUNT: '0',
  }
  const config = [
    ['core.hooksPath', '/dev/null'],
    ['protocol.version', '2'],
  ]
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    config.push(['http.extraHeader', `Authorization: Basic ${basic}`])
  }
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  env.GIT_CONFIG_COUNT = String(config.length)
  if (author) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = author.name
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = author.email
  }
  return env
}

/**
 * git <args> in the repository directory. Resolves to { stdout, code }; rejects
 * with GitError when the exit code is not in okCodes.
 * input: string or Buffer written to stdin; output: 'utf8' or 'buffer'.
 */
export function git(
  cwd,
  args,
  {
    token,
    author,
    input,
    env: extraEnv = {},
    timeout = 60_000,
    okCodes = [0],
    output = 'utf8',
  } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...environment({ token, author }), ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out = []
    const err = []
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', error => {
      clearTimeout(timer)
      reject(new GitError(error.message))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out)
      const stderr = Buffer.concat(err).toString('utf8')
      if (signal) {
        return reject(
          new GitError(`git ${args[0]} took too long`, { stderr, code })
        )
      }
      if (!okCodes.includes(code)) {
        return reject(
          new GitError(`git ${args[0]} failed`, { stderr, code })
        )
      }
      resolve({
        stdout: output === 'buffer' ? stdout : stdout.toString('utf8'),
        code,
      })
    })
    child.stdin.on('error', () => {}) // git may exit before reading all its input
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** Message for people, from what a network git command printed. */
export function explainRemoteError(error) {
  const text = `${error.stderr || ''} ${error.message || ''}`
  if (/Authentication failed|could not read Username|403|401|terminal prompts disabled/i.test(text)) {
    // GitHub answers the same for a private repository and a missing one
    return 'Accès refusé ou dépôt introuvable : vérifie l’adresse et le jeton (droit « Contents » en lecture et écriture).'
  }
  if (/not found|does not exist|404/i.test(text)) {
    return 'Dépôt introuvable : vérifie l’adresse, ou le jeton s’il est privé.'
  }
  if (/Could not resolve host|Failed to connect|timed out|took too long/i.test(text)) {
    return 'Le dépôt ne répond pas. Réessaie dans un moment.'
  }
  if (/protected branch|pre-receive hook declined|GH006/i.test(text)) {
    return 'Le dépôt refuse ce push (branche protégée ?).'
  }
  return 'Erreur git : ' + (error.stderr || error.message).trim().split('\n').slice(-3).join(' ')
}
