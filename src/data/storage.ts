import type { CatalogData, SelectedItem } from '../domain/types'
import type { OwnedQuantities } from '../domain/possession'

const DB_NAME = 'craftplanner'
const DB_VERSION = 2
const STORE_NAME = 'json'
const IMAGE_STORE_NAME = 'images'

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

export const loadStoredCatalog = (): Promise<CatalogData | null> => load('catalog')
export const saveStoredCatalog = (data: CatalogData): Promise<void> => save('catalog', data)

export async function loadCachedImages(): Promise<Array<{ itemId: number; blob: Blob }>> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(IMAGE_STORE_NAME, 'readonly')
    const store = transaction.objectStore(IMAGE_STORE_NAME)
    const keysRequest = store.getAllKeys()
    const valuesRequest = store.getAll()
    transaction.oncomplete = () => {
      database.close()
      resolve(keysRequest.result.map((key, index) => ({ itemId: Number(key), blob: valuesRequest.result[index] as Blob })))
    }
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function loadCachedImageIds(): Promise<number[]> {
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
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(IMAGE_STORE_NAME, 'readwrite')
    transaction.objectStore(IMAGE_STORE_NAME).put(blob, itemId)
    transaction.oncomplete = () => { database.close(); resolve() }
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
