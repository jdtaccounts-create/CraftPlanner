import type { CatalogData, SelectedItem } from '../domain/types'
import type { OwnedQuantities } from '../domain/possession'

const DB_NAME = 'craftplanner'
const DB_VERSION = 2
const STORE_NAME = 'json'
const IMAGE_STORE_NAME = 'images'

type SharedImageRow = {
  item_id: number
  bytes: number[]
}

type SharedAssetRow = {
  file: string
  bytes: number[]
}

export interface SharedSyncLock {
  app: string
  pid: number
  started_at: number
  heartbeat_at: number
  phase: string
}

export interface SharedSyncLockStatus {
  acquired: boolean
  lock: SharedSyncLock | null
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function invokeShared<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

function bytesToBlob(bytes: number[]): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/png' })
}

async function blobToBytes(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}

export function usesSharedTauriStorage(): boolean {
  return isTauriRuntime()
}

export async function readSharedSyncLock(): Promise<SharedSyncLock | null> {
  if (!isTauriRuntime()) return null
  return invokeShared<SharedSyncLock | null>('read_shared_sync_lock')
}

export async function acquireSharedSyncLock(app: string, phase: string): Promise<SharedSyncLockStatus> {
  if (!isTauriRuntime()) return { acquired: true, lock: null }
  return invokeShared<SharedSyncLockStatus>('acquire_shared_sync_lock', { app, phase })
}

export async function heartbeatSharedSyncLock(app: string, phase: string): Promise<SharedSyncLock | null> {
  if (!isTauriRuntime()) return null
  return invokeShared<SharedSyncLock | null>('heartbeat_shared_sync_lock', { app, phase })
}

export async function releaseSharedSyncLock(): Promise<void> {
  if (!isTauriRuntime()) return
  await invokeShared('release_shared_sync_lock')
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
      if (!request.result.objectStoreNames.contains(IMAGE_STORE_NAME)) request.result.createObjectStore(IMAGE_STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function load<T>(key: string): Promise<T | null> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve((request.result as T | undefined) || null)
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => database.close()
  })
}

async function save<T>(key: string, value: T): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(value, key)
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function saveStoredCatalog(data: CatalogData): Promise<void> {
  if (isTauriRuntime()) {
    await invokeShared('write_shared_json', { key: 'catalog', value: JSON.stringify(data) })
    return
  }
  await save('catalog', data)
}

export async function saveSharedJson(key: string, value: unknown): Promise<void> {
  if (isTauriRuntime()) {
    await invokeShared('write_shared_json', { key, value: JSON.stringify(value) })
    return
  }
  await save(key, value)
}

export async function loadSharedJson<T>(key: string): Promise<T | null> {
  if (isTauriRuntime()) {
    const text = await invokeShared<string | null>('read_shared_json', { key })
    return text ? JSON.parse(text) as T : null
  }
  return load<T>(key)
}

export async function loadStoredCatalog(): Promise<CatalogData | null> {
  if (isTauriRuntime()) {
    const text = await invokeShared<string | null>('read_shared_json', { key: 'catalog' })
    return text ? JSON.parse(text) as CatalogData : null
  }
  return load('catalog')
}

export interface FailedCachedImage {
  itemId: number
  source: string
  failedAt: string
  reason?: string
}

export async function loadFailedCachedImages(): Promise<FailedCachedImage[] | null> {
  if (isTauriRuntime()) {
    const text = await invokeShared<string | null>('read_shared_json', { key: 'failed-images' })
    return text ? JSON.parse(text) as FailedCachedImage[] : null
  }
  return load('failed-images')
}

export async function saveFailedCachedImages(rows: FailedCachedImage[]): Promise<void> {
  if (isTauriRuntime()) {
    await invokeShared('write_shared_json', { key: 'failed-images', value: JSON.stringify(rows) })
    return
  }
  await save('failed-images', rows)
}

export async function loadCachedImagesForIds(itemIds: Iterable<number>): Promise<Array<{ itemId: number; blob: Blob }>> {
  const ids = [...new Set([...itemIds].map(Number).filter(Number.isFinite))]
  if (!ids.length) return []
  if (isTauriRuntime()) {
    const rows = await invokeShared<SharedImageRow[]>('read_shared_images', { itemIds: ids })
    return rows.map((row) => ({ itemId: row.item_id, blob: bytesToBlob(row.bytes) }))
  }
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IMAGE_STORE_NAME, 'readonly')
    const store = transaction.objectStore(IMAGE_STORE_NAME)
    const rows: Array<{ itemId: number; blob: Blob }> = []
    let pending = ids.length
    for (const itemId of ids) {
      const request = store.get(itemId)
      request.onsuccess = () => {
        if (request.result instanceof Blob) rows.push({ itemId, blob: request.result })
        pending -= 1
        if (pending === 0) resolve(rows)
      }
      request.onerror = () => reject(request.error)
    }
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function loadCachedImageIds(): Promise<number[]> {
  if (isTauriRuntime()) return invokeShared<number[]>('list_shared_image_ids')
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IMAGE_STORE_NAME, 'readonly')
    const request = transaction.objectStore(IMAGE_STORE_NAME).getAllKeys()
    request.onsuccess = () => resolve(request.result.map(Number))
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => database.close()
  })
}

export async function saveCachedImage(itemId: number, blob: Blob): Promise<void> {
  if (isTauriRuntime()) {
    await invokeShared('write_shared_image', { itemId, bytes: await blobToBytes(blob) })
    return
  }
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(IMAGE_STORE_NAME, 'readwrite')
    transaction.objectStore(IMAGE_STORE_NAME).put(blob, itemId)
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function loadCharacteristicIconFiles(): Promise<string[]> {
  if (isTauriRuntime()) return invokeShared<string[]>('list_shared_characteristic_icons')
  return []
}

export async function loadCharacteristicIcons(files: Iterable<string>): Promise<Array<{ file: string; blob: Blob }>> {
  const uniqueFiles = [...new Set([...files].filter(Boolean))]
  if (!uniqueFiles.length) return []
  if (isTauriRuntime()) {
    const rows = await invokeShared<SharedAssetRow[]>('read_shared_characteristic_icons', { files: uniqueFiles })
    return rows.map((row) => ({ file: row.file, blob: bytesToBlob(row.bytes) }))
  }
  return []
}

export async function saveCharacteristicIcon(file: string, blob: Blob): Promise<void> {
  if (isTauriRuntime()) {
    await invokeShared('write_shared_characteristic_icon', { file, bytes: await blobToBytes(blob) })
  }
}

export async function clearCachedImages(): Promise<void> {
  if (isTauriRuntime()) {
    await invokeShared('clear_shared_images')
    return
  }
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(IMAGE_STORE_NAME, 'readwrite')
    transaction.objectStore(IMAGE_STORE_NAME).clear()
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function pruneCachedImages(validItemIds: Iterable<number>): Promise<number> {
  const valid = new Set([...validItemIds].map(Number).filter(Number.isFinite))
  if (isTauriRuntime()) {
    return invokeShared<number>('prune_shared_images', { validItemIds: [...valid] })
  }
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IMAGE_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(IMAGE_STORE_NAME)
    const request = store.getAllKeys()
    let removed = 0
    request.onsuccess = () => {
      for (const key of request.result) {
        const itemId = Number(key)
        if (!valid.has(itemId)) {
          store.delete(key)
          removed += 1
        }
      }
    }
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => { database.close(); resolve(removed) }
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function loadPlannerState(): Promise<{ selected: SelectedItem[]; owned: OwnedQuantities; craftCheckedKeys?: string[] } | null> {
  try {
    return JSON.parse(localStorage.getItem('craftplanner-state') || 'null')
  } catch {
    return null
  }
}

export async function savePlannerState(state: { selected: SelectedItem[]; owned: OwnedQuantities; craftCheckedKeys: string[] }): Promise<void> {
  localStorage.setItem('craftplanner-state', JSON.stringify(state))
}
