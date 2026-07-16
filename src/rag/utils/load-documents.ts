import { promises as fs } from 'fs'
import * as path from 'path'
import { Options as CsvParseOptions } from 'csv-parse/sync'

import { ensureUniqueId, loadLocalDocument, loadRemoteDocument } from './document-utils'
import { LoadDocumentsOptions } from '../interfaces/LoadDocumentsOptions'

/**
 * Load and normalize documents from a base folder and optional remote URLs.
 * - Supports .txt, .md, .pdf, .csv
 * - If no valid docs are found, creates a sample example.txt
 *
 * Remote documents are loaded first: their cache files live under
 * `folderBasePath` with deterministic names (used as document ids), and the
 * local scan skips them — otherwise a persistent cache directory would load
 * every remote document twice ("name" + "name#2") on subsequent boots.
 *
 * @param opts LoadDocumentsOptions with folderBasePath, optional logger, and optional remoteUrls.
 * @returns Array of { id, content } ready for chunking/indexing.
 */
export async function loadDocuments(opts: LoadDocumentsOptions): Promise<{ id: string; content: string }[]> {
  const { folderBasePath, logger } = opts

  const documents: { id: string; content: string }[] = []
  const options: CsvParseOptions = {
    skip_empty_lines: true,
    columns: false,
  }
  const usedIds = new Set<string>()

  try {
    await fs.mkdir(folderBasePath, { recursive: true })

    // Resolve remote document URLs (options or env: RAG_REMOTE_URLS)
    let urls: string[] = []
    if (opts?.remoteUrls && opts.remoteUrls.length > 0) {
      urls = opts.remoteUrls
    } else {
      const remoteVar = process.env.RAG_REMOTE_URLS
      if (remoteVar && remoteVar.trim().length > 0) {
        try {
          if (remoteVar.trim().startsWith('[')) {
            urls = JSON.parse(remoteVar)
          } else {
            urls = remoteVar
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          }
        } catch (e) {
          logger?.error?.(`[RAG] RAG_REMOTE_URLS is not valid JSON/CSV: ${e instanceof Error ? e.message : e}`)
          urls = []
        }
      }
    }

    if (urls.length) {
      logger?.log?.(`[RAG] Downloading ${urls.length} remote document(s) into cache under: ${folderBasePath}`)
      const results = await Promise.all(
        urls.map((u) => loadRemoteDocument(u, folderBasePath, options, usedIds, logger)),
      )
      for (const doc of results) {
        if (doc) documents.push(doc)
      }
    }

    // Local documents — skip files already loaded through the remote cache
    const files = await fs.readdir(folderBasePath)
    for (const file of files) {
      if (usedIds.has(file)) continue
      const fullPath = path.join(folderBasePath, file)
      const stat = await fs.stat(fullPath)
      if (!stat.isFile()) continue
      try {
        const doc = await loadLocalDocument(fullPath, file, options, usedIds, logger)
        if (doc) documents.push(doc)
      } catch (err) {
        logger?.error?.(`[RAG] Error processing file "${file}": ${err}`)
      }
    }

    // If no documents found anywhere, create a sample file
    if (documents.length === 0) {
      const samplePath = path.join(folderBasePath, 'example.txt')
      const exampleText = 'This is an example document for testing the RAG system.'
      await fs.writeFile(samplePath, exampleText)
      documents.push({ id: ensureUniqueId(usedIds, 'example.txt'), content: exampleText })
      logger?.log?.(`[RAG] No documents found. Created sample file: "example.txt"`)
    }
  } catch (err) {
    logger?.error?.(`[RAG] Error loading documents from ${folderBasePath}: ${err}`)
  }
  return documents
}
