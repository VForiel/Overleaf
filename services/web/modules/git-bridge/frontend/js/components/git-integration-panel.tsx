import { useState } from 'react'
import getMeta from '@/utils/meta'
import { postJSON } from '@/infrastructure/fetch-json'
import { useProjectContext } from '@/shared/context/project-context'
import OLButton from '@/shared/components/ol/ol-button'

// "Git" card of the editor's Integrations panel: clone address of the project
// and creation of a git token (module git-bridge of the fork).

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard refused: the field stays selectable
    }
  }

  return (
    <div className="d-flex gap-2 mb-2">
      <input
        className="form-control form-control-sm font-monospace"
        type="text"
        readOnly
        value={value}
        aria-label={label}
        onFocus={event => event.currentTarget.select()}
      />
      <OLButton variant="secondary" size="sm" onClick={copy}>
        {copied ? 'Copié' : 'Copier'}
      </OLButton>
    </div>
  )
}

export default function GitIntegrationPanel() {
  const { projectId, name } = useProjectContext()
  const baseUrl = getMeta('ol-gitBridgePublicBaseUrl')
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  if (!baseUrl) return null
  const cloneUrl = `${baseUrl}/${projectId}`

  async function createToken() {
    setLoading(true)
    setError(null)
    try {
      const answer = await postJSON<{ token: string }>('/user/git/tokens', {
        body: { name: `Éditeur (${name || 'projet'})`.slice(0, 80) },
      })
      setToken(answer.token)
    } catch (err: any) {
      setError(err?.data?.message || 'Le jeton n’a pas pu être créé.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="integrations-panel-card-contents d-block">
      <h3 className="integrations-panel-card-title mb-1">Git</h3>
      <p className="integrations-panel-card-description mb-3">
        Clone le projet, travaille en local, puis fais pull et push. Nom
        d’utilisateur : <code>git</code>, mot de passe : un jeton git.
      </p>

      <CopyField value={`git clone ${cloneUrl}`} label="Commande de clonage" />

      {token ? (
        <>
          <p className="integrations-panel-card-description mt-3 mb-1">
            Ton jeton, affiché une seule fois :
          </p>
          <CopyField value={token} label="Jeton git" />
        </>
      ) : (
        <OLButton
          variant="primary"
          size="sm"
          className="mt-2"
          onClick={createToken}
          isLoading={loading}
        >
          Créer un jeton git
        </OLButton>
      )}
      {error && <p className="text-danger small mt-2 mb-0">{error}</p>}

      <p className="integrations-panel-card-description mt-3">
        <a href="/user/git" target="_blank" rel="noopener">
          Gérer mes jetons et aide
        </a>
      </p>
    </div>
  )
}
