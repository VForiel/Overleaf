import Path from 'node:path'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectLocator from '../../../../app/src/Features/Project/ProjectLocator.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectCreationHandler from '../../../../app/src/Features/Project/ProjectCreationHandler.mjs'
import ProjectRootDocManager from '../../../../app/src/Features/Project/ProjectRootDocManager.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'
import Settings from '@overleaf/settings'
import { ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'

// Changes made through the connector show up as "mcp" in the project history.
const SOURCE = 'mcp'
const MAX_DOC_CHARS = 2_000_000
const MAX_LOG_CHARS = 20_000

export class ToolError extends Error {}

const projectId = {
  type: 'string',
  description: 'Project id (24 hex characters), as given by list_projects',
}
const filePath = {
  type: 'string',
  description:
    'Path inside the project, e.g. "main.tex" or "chapters/intro.tex"',
}

export const TOOLS = [
  {
    name: 'list_projects',
    description:
      'List the Overleaf projects the user can access, with their id, name, access level and last update.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_files',
    description:
      'List the files and folders of a project. Text documents can be read and edited; other files (images, PDFs…) are binary.',
    inputSchema: {
      type: 'object',
      properties: { project_id: projectId },
      required: ['project_id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_file',
    description:
      'Read a text document of a project, including unsaved edits of people currently working on it.',
    inputSchema: {
      type: 'object',
      properties: { project_id: projectId, path: filePath },
      required: ['project_id', 'path'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_file',
    description:
      'Create a text document, or replace its whole content. Missing folders are created. People editing the document see the change live.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        path: filePath,
        content: { type: 'string', description: 'Full new content' },
      },
      required: ['project_id', 'path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace one exact, unique passage of a text document (prefer this to write_file for small changes).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        path: filePath,
        old_text: {
          type: 'string',
          description: 'Text to replace; must appear exactly once',
        },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['project_id', 'path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'move_file',
    description: 'Rename or move a document, file or folder inside a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        path: filePath,
        new_path: {
          type: 'string',
          description: 'New path inside the project',
        },
      },
      required: ['project_id', 'path', 'new_path'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Delete a document, file or folder (it can be restored from the project history).',
    inputSchema: {
      type: 'object',
      properties: { project_id: projectId, path: filePath },
      required: ['project_id', 'path'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'compile',
    description:
      'Compile the project with LaTeX and return the status, the errors and warnings, and the end of the log.',
    inputSchema: {
      type: 'object',
      properties: { project_id: projectId },
      required: ['project_id'],
    },
  },
  {
    name: 'create_project',
    description:
      'Create a new project with a basic main.tex, owned by the user.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Project name' } },
      required: ['name'],
    },
  },
]

function text(value) {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

function requireString(args, name, { allowEmpty = false } = {}) {
  const value = args[name]
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new ToolError(`"${name}" is required`)
  }
  return value
}

function cleanPath(value) {
  const normalised = Path.posix.normalize('/' + value.replace(/\\/g, '/'))
  if (normalised === '/' || normalised.includes('/../')) {
    throw new ToolError(`invalid path: ${value}`)
  }
  return normalised.replace(/\/$/, '')
}

async function checkProject(userId, args, { write = false } = {}) {
  const id = requireString(args, 'project_id')
  if (!ObjectId.isValid(id) || !/^[a-f0-9]{24}$/.test(id)) {
    throw new ToolError('invalid project_id')
  }
  const allowed = write
    ? await AuthorizationManager.promises.canUserWriteProjectContent(
        userId,
        id,
        null
      )
    : await AuthorizationManager.promises.canUserReadProject(userId, id, null)
  if (!allowed) {
    throw new ToolError(
      write
        ? 'this project does not exist or you cannot edit it'
        : 'this project does not exist or you cannot open it'
    )
  }
  return id
}

async function findEntity(projectId, path) {
  try {
    const { element, type } = await ProjectLocator.promises.findElementByPath({
      project_id: projectId,
      path,
      exactCaseMatch: true,
    })
    if (!element) throw new Error('not found')
    return { element, type }
  } catch (error) {
    throw new ToolError(`no such file or folder: ${path}`)
  }
}

async function readDoc(projectId, path) {
  const { element, type } = await findEntity(projectId, path)
  if (type !== 'doc') {
    throw new ToolError(
      type === 'file'
        ? `${path} is a binary file, it cannot be read as text`
        : `${path} is a folder`
    )
  }
  // From the document updater: includes edits not yet saved to the database
  const { lines } = await DocumentUpdaterHandler.promises.getDocument(
    projectId,
    element._id.toString(),
    -1
  )
  return { doc: element, content: lines.join('\n') }
}

async function writeDoc(userId, projectId, path, content) {
  if (content.length > MAX_DOC_CHARS) {
    throw new ToolError('document too large')
  }
  const { doc } = await EditorController.promises.upsertDocWithPath(
    projectId,
    path,
    content.split(/\r?\n/),
    SOURCE,
    userId
  )
  return doc
}

const ACCESS = {
  owned: 'owner',
  readAndWrite: 'read and write',
  review: 'review',
  readOnly: 'read only',
  tokenReadAndWrite: 'read and write (link)',
  tokenReadOnly: 'read only (link)',
}

const handlers = {
  async list_projects(userId) {
    const projects = await ProjectGetter.promises.findAllUsersProjects(userId, {
      name: 1,
      lastUpdated: 1,
      archived: 1,
      trashed: 1,
    })
    const result = []
    for (const [kind, label] of Object.entries(ACCESS)) {
      for (const project of projects[kind] || []) {
        const hidden = [project.archived, project.trashed].some(
          list =>
            Array.isArray(list) && list.some(id => id.toString() === userId)
        )
        if (hidden) continue
        result.push({
          id: project._id.toString(),
          name: project.name,
          access: label,
          last_updated: project.lastUpdated,
        })
      }
    }
    result.sort((a, b) => new Date(b.last_updated) - new Date(a.last_updated))
    return text(result)
  },

  async list_files(userId, args) {
    const id = await checkProject(userId, args)
    const project = await ProjectGetter.promises.getProject(id, {
      name: 1,
      rootFolder: 1,
      rootDoc_id: 1,
    })
    const { docs, files, folders } =
      ProjectEntityHandler.getAllEntitiesFromProject(project)
    const rootDoc = docs.find(
      d =>
        project.rootDoc_id &&
        d.doc._id.toString() === project.rootDoc_id.toString()
    )
    return text({
      name: project.name,
      main_document: rootDoc ? rootDoc.path.slice(1) : null,
      documents: docs.map(d => d.path.slice(1)).sort(),
      binary_files: files.map(f => f.path.slice(1)).sort(),
      folders: folders
        .map(f => f.path.slice(1))
        .filter(Boolean)
        .sort(),
    })
  },

  async read_file(userId, args) {
    const id = await checkProject(userId, args)
    const { content } = await readDoc(
      id,
      cleanPath(requireString(args, 'path'))
    )
    return text(content)
  },

  async write_file(userId, args) {
    const id = await checkProject(userId, args, { write: true })
    const path = cleanPath(requireString(args, 'path'))
    const content = requireString(args, 'content', { allowEmpty: true })
    const existing = await findEntity(id, path).catch(() => null)
    if (existing && existing.type === 'folder') {
      throw new ToolError(`${path} is a folder`)
    }
    await writeDoc(userId, id, path, content)
    return text(`${existing ? 'Replaced' : 'Created'} ${path.slice(1)}`)
  },

  async edit_file(userId, args) {
    const id = await checkProject(userId, args, { write: true })
    const path = cleanPath(requireString(args, 'path'))
    const oldText = requireString(args, 'old_text')
    const newText = requireString(args, 'new_text', { allowEmpty: true })
    const { content } = await readDoc(id, path)
    const first = content.indexOf(oldText)
    if (first === -1) {
      throw new ToolError(
        'old_text was not found (it must match exactly, spaces and line breaks included)'
      )
    }
    if (content.indexOf(oldText, first + 1) !== -1) {
      throw new ToolError(
        'old_text appears several times: include more context so that it is unique'
      )
    }
    await writeDoc(
      userId,
      id,
      path,
      content.slice(0, first) + newText + content.slice(first + oldText.length)
    )
    return text(`Edited ${path.slice(1)}`)
  },

  async move_file(userId, args) {
    const id = await checkProject(userId, args, { write: true })
    const path = cleanPath(requireString(args, 'path'))
    const newPath = cleanPath(requireString(args, 'new_path'))
    if (newPath === path) return text('Nothing to do')
    if (newPath.startsWith(path + '/')) {
      throw new ToolError('a folder cannot be moved inside itself')
    }
    const { element, type } = await findEntity(id, path)
    const taken = await findEntity(id, newPath).catch(() => null)
    if (taken) throw new ToolError(`${newPath.slice(1)} already exists`)
    const entityId = element._id.toString()
    const oldDir = Path.posix.dirname(path)
    const newDir = Path.posix.dirname(newPath)
    if (newDir !== oldDir) {
      let folderId
      if (newDir === '/') {
        const project = await ProjectGetter.promises.getProject(id, {
          rootFolder: 1,
        })
        folderId = project.rootFolder[0]._id.toString()
      } else {
        const { lastFolder } = await EditorController.promises.mkdirp(
          id,
          newDir,
          userId
        )
        folderId = lastFolder._id.toString()
      }
      await EditorController.promises.moveEntity(
        id,
        entityId,
        folderId,
        type,
        userId,
        SOURCE
      )
    }
    const newName = Path.posix.basename(newPath)
    if (newName !== Path.posix.basename(path)) {
      await EditorController.promises.renameEntity(
        id,
        entityId,
        type,
        newName,
        userId,
        SOURCE
      )
    }
    return text(`Moved ${path.slice(1)} to ${newPath.slice(1)}`)
  },

  async delete_file(userId, args) {
    const id = await checkProject(userId, args, { write: true })
    const path = cleanPath(requireString(args, 'path'))
    await findEntity(id, path)
    await EditorController.promises.deleteEntityWithPath(
      id,
      path,
      SOURCE,
      userId
    )
    return text(`Deleted ${path.slice(1)}`)
  },

  async compile(userId, args) {
    const id = await checkProject(userId, args)
    // Picks a main document when none is set, as the editor does
    const rootDoc =
      await ProjectRootDocManager.promises.ensureRootDocumentIsValid(id)
    const result = await CompileManager.promises.compile(id, userId, {
      isAutoCompile: false,
      fileLineErrors: true,
      stopOnFirstError: false,
    })
    const summary = {
      status: result.status,
      main_document: rootDoc?.rootResourcePath?.replace(/^\//, '') ?? null,
      pdf: (result.outputFiles || []).some(f => f.path === 'output.pdf'),
      project_url: `${Settings.siteUrl}/project/${id}`,
    }
    if (result.status === 'too-recently-compiled') {
      summary.hint = 'wait a few seconds before compiling again'
    }
    if (result.validationProblems) {
      summary.validation_problems = result.validationProblems
    }
    const hasLog = (result.outputFiles || []).some(f => f.path === 'output.log')
    if (hasLog) {
      const log = await outputLog(id, userId, result)
      Object.assign(summary, parseLog(log))
      summary.log_tail = log.slice(-MAX_LOG_CHARS / 4)
    }
    return text(summary)
  },

  async create_project(userId, args) {
    const name = requireString(args, 'name').trim().slice(0, 150)
    const project = await ProjectCreationHandler.promises.createBasicProject(
      userId,
      name
    )
    return text({
      id: project._id.toString(),
      name: project.name,
      url: `${Settings.siteUrl}/project/${project._id}`,
    })
  },
}

async function outputLog(projectId, userId, result) {
  const compileAsUser = Settings.disablePerUserCompiles ? undefined : userId
  const stream = await ClsiManager.promises.getOutputFileStream(
    projectId,
    compileAsUser,
    result.clsiServerId,
    result.buildId,
    'output.log'
  )
  let log = ''
  for await (const chunk of stream) {
    log += chunk.toString()
  }
  return log
}

/** Errors ("! …" or "file:line: …") and warnings of a LaTeX log, as short strings. */
export function parseLog(log) {
  const lines = log.split('\n')
  const errors = []
  const warnings = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^(!|\S+:\d+: )/.test(line)) {
      const context = lines
        .slice(i, i + 3)
        .join('\n')
        .trim()
      if (!errors.includes(context)) errors.push(context)
    } else if (/(LaTeX|Package \S+|Class \S+) Warning:/.test(line)) {
      let warning = line
      for (
        let j = i + 1;
        j < lines.length && /^\(\S+\)\s/.test(lines[j]);
        j++
      ) {
        warning += ' ' + lines[j].replace(/^\(\S+\)\s+/, '')
      }
      if (!warnings.includes(warning)) warnings.push(warning)
    }
  }
  return { errors: errors.slice(0, 30), warnings: warnings.slice(0, 30) }
}

export async function callTool(userId, name, args) {
  const handler = Object.hasOwn(handlers, name) ? handlers[name] : null
  if (!handler) return null
  return await handler(userId, args || {})
}
