import fs from 'node:fs'
import Path from 'node:path'
import logger from '@overleaf/logger'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import FileTypeManager from '../../../../app/src/Features/Uploads/FileTypeManager.mjs'

// Writing a set of files into a project through the editor, shared by the
// git-bridge pushes and the sync with a remote repository: changes show up live
// for collaborators and in the history, under the given source.

/** Type of every file of the project ('doc' or 'file'), by path without leading slash. */
export async function currentFiles(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootFolder: 1,
  })
  const { docs, files } =
    ProjectEntityHandler.getAllEntitiesFromProject(project)
  const types = new Map()
  for (const { path } of docs) types.set(path.slice(1), 'doc')
  for (const { path } of files) types.set(path.slice(1), 'file')
  return types
}

/** Creates or replaces one file from a file on disk (text becomes an editable doc). */
export async function writeFile(
  projectId,
  userId,
  name,
  fsPath,
  existingType,
  source
) {
  const { binary, encoding } = await FileTypeManager.promises.getType(
    Path.basename(name),
    fsPath,
    existingType
  )
  if (binary) {
    await EditorController.promises.upsertFileWithPath(
      projectId,
      `/${name}`,
      fsPath,
      null,
      source,
      userId
    )
  } else {
    const content = await fs.promises.readFile(fsPath, encoding)
    // Unix, DOS and classic Mac newlines, as for uploads
    await EditorController.promises.upsertDocWithPath(
      projectId,
      `/${name}`,
      content.split(/\r\n|\n|\r/),
      source,
      userId
    )
  }
}

/** Folders left empty by the deletions, deepest first. */
export function foldersToRemove(deletedPaths, remainingPaths) {
  const candidates = new Set()
  for (const path of deletedPaths) {
    const parts = path.split('/')
    for (let i = parts.length - 1; i > 0; i--) {
      candidates.add(parts.slice(0, i).join('/'))
    }
  }
  return [...candidates]
    .filter(
      folder => !remainingPaths.some(path => path.startsWith(`${folder}/`))
    )
    .sort((a, b) => b.split('/').length - a.split('/').length)
}

/**
 * Deletes files, then the folders they leave empty (git has no empty folders).
 * remainingPaths: every file path the project keeps.
 */
export async function deleteFiles(
  projectId,
  userId,
  paths,
  remainingPaths,
  source
) {
  for (const path of paths) {
    await EditorController.promises.deleteEntityWithPath(
      projectId,
      `/${path}`,
      source,
      userId
    )
  }
  for (const folder of foldersToRemove(paths, remainingPaths)) {
    try {
      await EditorController.promises.deleteEntityWithPath(
        projectId,
        `/${folder}`,
        source,
        userId
      )
    } catch (err) {
      logger.debug({ err, projectId, folder }, 'folder kept')
    }
  }
}
