import { FormEvent, useCallback, useEffect, useState } from 'react'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'
import { useProjectContext } from '@/shared/context/project-context'
import OLButton from '@/shared/components/ol/ol-button'

// "Remote repository" card of the editor's Integrations panel: links the
// project to a branch of a GitHub / GitLab / … repository, with Pull and Push
// buttons (module git-bridge of the fork, GitSync.mjs on the server).

type Status = {
  linked: boolean
  canAdmin: boolean
  url?: string
  branch?: string
  hasToken?: boolean
  lastSync?: {
    direction: 'pull' | 'push'
    commit: string
    at: string
    by: string | null
  } | null
}

type Outcome = {
  kind: 'success' | 'error'
  message: string
  details?: string[]
}

function errorOutcome(err: any): Outcome {
  const data = err?.data || {}
  return {
    kind: 'error',
    message:
      (typeof data.message === 'string' && data.message) ||
      'La demande n’a pas abouti.',
    details: data.conflicts,
  }
}

function repoLabel(url: string) {
  try {
    const { host, pathname } = new URL(url)
    return `${host}${pathname.replace(/\.git$/, '')}`
  } catch {
    return url
  }
}

function OutcomeMessage({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null
  return (
    <div
      className={
        outcome.kind === 'error' ? 'text-danger small mt-2' : 'small mt-2'
      }
      role="status"
    >
      {outcome.message}
      {outcome.details && outcome.details.length > 0 && (
        <ul className="mb-0 ps-3">
          {outcome.details.map(item => (
            <li key={item}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function BranchField({
  branches,
  value,
  onChange,
}: {
  branches: string[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <>
      <input
        className="form-control form-control-sm"
        list="git-sync-branches"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="main"
        aria-label="Branche"
      />
      <datalist id="git-sync-branches">
        {branches.map(branch => (
          <option key={branch} value={branch} />
        ))}
      </datalist>
    </>
  )
}

function LinkForm({
  base,
  status,
  onDone,
  onCancel,
}: {
  base: string
  status: Status
  onDone: (status: Status) => void
  onCancel?: () => void
}) {
  const [url, setUrl] = useState(status.url || '')
  const [token, setToken] = useState('')
  const [branch, setBranch] = useState(status.branch || '')
  const [branches, setBranches] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  async function loadBranches() {
    setBusy(true)
    setOutcome(null)
    try {
      const answer = await postJSON<{
        branches: string[]
        defaultBranch: string | null
      }>(`${base}/branches`, { body: { url, token } })
      setBranches(answer.branches)
      if (!branch) setBranch(answer.defaultBranch || answer.branches[0] || 'main')
      setOutcome({
        kind: 'success',
        message: answer.branches.length
          ? `Accès vérifié : ${answer.branches.length} branche(s).`
          : 'Accès vérifié : le dépôt est vide, le premier push créera la branche.',
      })
    } catch (err) {
      setOutcome(errorOutcome(err))
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setOutcome(null)
    try {
      const answer = await postJSON<Status>(`${base}/link`, {
        body: { url, token, branch: branch || 'main' },
      })
      onDone({ ...answer, canAdmin: true })
    } catch (err) {
      setOutcome(errorOutcome(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <label className="form-label small mb-1" htmlFor="git-sync-url">
        Adresse https du dépôt
      </label>
      <input
        id="git-sync-url"
        className="form-control form-control-sm mb-2"
        type="url"
        required
        value={url}
        onChange={event => setUrl(event.target.value)}
        placeholder="https://github.com/compte/depot.git"
      />
      <label className="form-label small mb-1" htmlFor="git-sync-token">
        Jeton d’accès{' '}
        {status.hasToken && status.url === url
          ? '(laisser vide pour garder l’actuel)'
          : '(vide pour un dépôt public, en lecture seule)'}
      </label>
      <input
        id="git-sync-token"
        className="form-control form-control-sm mb-1"
        type="password"
        autoComplete="off"
        value={token}
        onChange={event => setToken(event.target.value)}
      />
      <p className="integrations-panel-card-description mb-2">
        GitHub : Settings › Developer settings › Fine-grained tokens, limité à
        ce dépôt, droit « Contents » en lecture et écriture. Le jeton est
        chiffré sur le serveur et n’est plus jamais affiché.
      </p>
      <label className="form-label small mb-1">Branche</label>
      <div className="d-flex gap-2 mb-2">
        <BranchField branches={branches} value={branch} onChange={setBranch} />
        <OLButton
          variant="secondary"
          size="sm"
          onClick={loadBranches}
          disabled={busy || !url}
        >
          Vérifier
        </OLButton>
      </div>
      <div className="d-flex gap-2">
        <OLButton type="submit" variant="primary" size="sm" isLoading={busy}>
          Relier
        </OLButton>
        {onCancel && (
          <OLButton variant="secondary" size="sm" onClick={onCancel}>
            Annuler
          </OLButton>
        )}
      </div>
      <OutcomeMessage outcome={outcome} />
    </form>
  )
}

function LinkedView({
  base,
  status,
  setStatus,
  onEdit,
}: {
  base: string
  status: Status
  setStatus: (status: Status) => void
  onEdit: () => void
}) {
  const [message, setMessage] = useState('')
  const [strategy, setStrategy] = useState<'merge' | 'replace'>('merge')
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [branches, setBranches] = useState<string[] | null>(null)
  const [branch, setBranch] = useState(status.branch || '')

  async function run(name: string, action: () => Promise<any>) {
    setBusy(name)
    setOutcome(null)
    try {
      const answer = await action()
      if (answer?.status) setStatus({ ...answer.status, canAdmin: status.canAdmin })
      setOutcome({
        kind: 'success',
        message: answer?.message || 'Fait.',
        details: answer?.skipped?.length
          ? ['Ignorés :', ...answer.skipped]
          : undefined,
      })
      return answer
    } catch (err) {
      setOutcome(errorOutcome(err))
    } finally {
      setBusy(null)
    }
  }

  function pull() {
    if (
      strategy === 'replace' &&
      !window.confirm(
        `Le projet va devenir exactement la branche « ${status.branch} » : ce qui n’y est pas sera supprimé du projet (l’historique d’Overleaf le garde). Continuer ?`
      )
    ) {
      return
    }
    run('pull', () => postJSON(`${base}/pull`, { body: { strategy } }))
  }

  async function push() {
    const answer = await run('push', () =>
      postJSON(`${base}/push`, { body: { message } })
    )
    if (answer) setMessage('')
  }

  async function showBranches() {
    const answer = await run('branches', () =>
      postJSON<{ branches: string[] }>(`${base}/branches`, { body: {} })
    )
    if (answer) {
      setBranches(answer.branches)
      setOutcome(null)
    }
  }

  async function saveBranch() {
    await run('branch', async () => {
      const answer = await postJSON<Status>(`${base}/branch`, {
        body: { branch },
      })
      setStatus({ ...answer, canAdmin: status.canAdmin })
      setBranches(null)
      return { message: `Branche « ${answer.branch} » sélectionnée.` }
    })
  }

  function unlink() {
    if (!window.confirm('Délier ce projet du dépôt ? Ni le projet ni le dépôt ne sont modifiés.')) return
    run('unlink', async () => {
      await postJSON(`${base}/unlink`)
      setStatus({ linked: false, canAdmin: status.canAdmin })
      return { message: 'Projet délié.' }
    })
  }

  const last = status.lastSync
  return (
    <>
      <p className="integrations-panel-card-description mb-2">
        <a href={status.url} target="_blank" rel="noopener noreferrer">
          {repoLabel(status.url || '')}
        </a>
        {', branche '}
        <code>{status.branch}</code>
        {branches === null && (
          <>
            {' '}
            <button
              type="button"
              className="btn btn-link btn-sm p-0 align-baseline"
              onClick={showBranches}
              disabled={busy !== null}
            >
              changer
            </button>
          </>
        )}
      </p>
      {branches !== null && (
        <div className="d-flex gap-2 mb-2">
          <BranchField branches={branches} value={branch} onChange={setBranch} />
          <OLButton
            variant="secondary"
            size="sm"
            onClick={saveBranch}
            isLoading={busy === 'branch'}
          >
            Choisir
          </OLButton>
        </div>
      )}
      <p className="integrations-panel-card-description mb-3">
        {last
          ? `Dernier ${last.direction} le ${new Date(last.at).toLocaleString('fr-FR')}${last.by ? ` par ${last.by}` : ''} (${last.commit.slice(0, 7)}).`
          : 'Pas encore synchronisé : commence par un pull (ou un push vers une branche vide ou nouvelle).'}
      </p>

      <div className="d-flex gap-2 mb-3">
        <select
          className="form-select form-select-sm"
          value={strategy}
          onChange={event =>
            setStrategy(event.target.value as 'merge' | 'replace')
          }
          aria-label="Façon de faire le pull"
        >
          <option value="merge">Fusionner avec le projet</option>
          <option value="replace">Remplacer le projet par la branche</option>
        </select>
        <OLButton
          variant="secondary"
          size="sm"
          onClick={pull}
          isLoading={busy === 'pull'}
          disabled={busy !== null}
        >
          Pull
        </OLButton>
      </div>

      <div className="d-flex gap-2">
        <input
          className="form-control form-control-sm"
          value={message}
          onChange={event => setMessage(event.target.value)}
          placeholder="Message du commit"
          aria-label="Message du commit"
          maxLength={2000}
        />
        <OLButton
          variant="primary"
          size="sm"
          onClick={push}
          isLoading={busy === 'push'}
          disabled={busy !== null}
        >
          Push
        </OLButton>
      </div>

      <OutcomeMessage outcome={outcome} />

      {status.canAdmin && (
        <p className="integrations-panel-card-description mt-3 mb-0">
          <button
            type="button"
            className="btn btn-link btn-sm p-0 align-baseline"
            onClick={onEdit}
          >
            Modifier le dépôt ou le jeton
          </button>
          {' · '}
          <button
            type="button"
            className="btn btn-link btn-sm p-0 align-baseline"
            onClick={unlink}
          >
            Délier
          </button>
        </p>
      )}
    </>
  )
}

export default function GitSyncCard() {
  const { projectId } = useProjectContext()
  const base = `/project/${projectId}/git-sync`
  const [status, setStatus] = useState<Status | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await getJSON<Status>(base))
    } catch {
      setUnavailable(true)
    }
  }, [base])

  useEffect(() => {
    load()
  }, [load])

  if (unavailable) return null

  return (
    <div className="integrations-panel-card-contents d-block">
      <h3 className="integrations-panel-card-title mb-1">Dépôt distant</h3>
      <p className="integrations-panel-card-description mb-3">
        Relie le projet à une branche d’un dépôt GitHub, GitLab… et
        synchronise-le avec Pull et Push.
      </p>
      {!status ? (
        <p className="integrations-panel-card-description">Chargement…</p>
      ) : status.linked && !editing ? (
        <LinkedView
          base={base}
          status={status}
          setStatus={setStatus}
          onEdit={() => setEditing(true)}
        />
      ) : status.canAdmin ? (
        <LinkForm
          base={base}
          status={status}
          onDone={next => {
            setStatus(next)
            setEditing(false)
          }}
          onCancel={editing ? () => setEditing(false) : undefined}
        />
      ) : (
        <p className="integrations-panel-card-description">
          Seul le propriétaire du projet peut le relier à un dépôt.
        </p>
      )}
    </div>
  )
}
