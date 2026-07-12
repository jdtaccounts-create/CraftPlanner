<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Notify } from 'quasar'
import { createCatalogSearchIndex, itemCategory, searchCatalog } from './domain/catalog'
import { buildCraftPlan, craftPlanLines } from './domain/craft'
import { allocateOwned, setCraftLineAllocation, setCraftLineComplete, setOwned, type OwnedQuantities } from './domain/possession'
import { compareCatalogItems, compareCraftLines as compareResourceCraftLines } from './domain/resourceSort'
import { addItemSet, addSelectedItem, parseItemList, setSelectedQuantity, type ParsedChoice, type ParsedChoiceOption } from './domain/selection'
import { ITEM_CATEGORIES, type CatalogData, type CraftLine, type ItemCategory, type SelectedItem } from './domain/types'
import { loadCatalogData } from './data/repository'
import { checkCatalogStatus, ESTIMATED_IMAGE_BYTES, type SyncEndpoint, type SyncProgressEvent } from './data/sync'
import {
  acquireSharedSyncLock,
  heartbeatSharedSyncLock,
  loadCachedImagesForIds,
  loadPlannerState,
  readSharedSyncLock,
  releaseSharedSyncLock,
  savePlannerState,
  type SharedSyncLock,
} from './data/storage'

const data = shallowRef<CatalogData | null>(null)
const selected = ref<SelectedItem[]>([])
const owned = ref<OwnedQuantities>({})
const craftCheckedKeys = ref<Set<string>>(new Set())
const pendingChoices = ref<ParsedChoice[]>([])
const query = ref('')
const searchOpen = ref(false)
const theme = ref<'dark' | 'light'>('dark')
const craftOpen = ref(false)
const loading = ref(true)
const status = ref('Chargement des données locales...')
const cachedImageUrls = ref<Map<number, string>>(new Map())
const appUpdate = shallowRef<any>(null)
const showAppUpdatePrompt = ref(false)
const checkingAppUpdate = ref(false)
const installingAppUpdate = ref(false)
const appUpdateProgress = ref('')
let overflowFrame: number | undefined
let saveStateTimer: number | undefined
let wheelQuantityLockUntil = 0
const WHEEL_QUANTITY_LOCK_MS = 650
const quantityFormatter = new Intl.NumberFormat('fr-FR')
const byteFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
const FORCE_FULL_SYNC_KEY = 'craftplanner-force-full-sync'
const FORCE_FULL_SYNC_PARAM = 'forceFullSync'
const EXTERNAL_SYNC_IDLE_CONFIRM_MS = 3500

type SyncTaskKey = SyncEndpoint | 'images' | 'statIcons'

interface SyncTaskState {
  key: SyncTaskKey
  label: string
  done: number
  total: number
  bytesDone: number
  bytesTotal?: number
}

const syncTaskOrder: SyncTaskKey[] = ['items', 'recipes', 'itemSets', 'characteristics', 'images', 'statIcons']
const syncTaskLabels: Record<SyncTaskKey, string> = {
  items: 'Items',
  recipes: 'Recettes',
  itemSets: 'Panoplies',
  characteristics: 'Stats',
  images: 'Images',
  statIcons: 'Icônes stats',
}

function createSyncTasks(): Record<SyncTaskKey, SyncTaskState> {
  return Object.fromEntries(syncTaskOrder.map((key) => [key, {
    key,
    label: syncTaskLabels[key],
    done: 0,
    total: 0,
    bytesDone: 0,
  }])) as Record<SyncTaskKey, SyncTaskState>
}

const syncVisible = ref(false)
const syncExternalWait = ref(false)
const syncPhase = ref('Vérification des données DofusDB...')
const syncStartedAt = ref(Date.now())
const syncUpdatedAt = ref(Date.now())
const syncMeasuredSpeed = ref(0)
const syncTasks = ref<Record<SyncTaskKey, SyncTaskState>>(createSyncTasks())
let syncSpeedSamples: Array<{ at: number; bytesDone: number }> = []
let syncHideTimer: number | undefined

function persistPlannerState(): void {
  void savePlannerState({ selected: selected.value, owned: owned.value, craftCheckedKeys: [...craftCheckedKeys.value] })
}

const searchIndex = computed(() => data.value ? createCatalogSearchIndex(data.value.items, data.value.itemSets) : null)
const results = computed(() => searchIndex.value && data.value ? searchCatalog(searchIndex.value, query.value, 50, (a, b) => compareCatalogItems(data.value!, a, b)) : [])
const showSearchResults = computed(() => searchOpen.value && query.value && results.value.length)
const plan = computed(() => data.value ? buildCraftPlan(data.value, selected.value) : null)
const allCraftLines = computed(() => plan.value ? craftPlanLines(plan.value) : [])
const craftAllocations = computed(() => allocateOwned(allCraftLines.value, owned.value))
const syncLocked = computed(() => loading.value || syncVisible.value)
const syncRows = computed(() => {
  const rows = syncTaskOrder.map((key) => syncTasks.value[key])
  return syncVisible.value ? rows : rows.filter((task) => task.total > 0 || task.done > 0)
})
const syncTotals = computed(() => {
  const rows = syncRows.value
  const estimatedBytesTotal = rows.reduce((total, task) => total + estimatedTaskBytesTotal(task), 0)
  return {
    done: rows.reduce((total, task) => total + task.done, 0),
    total: rows.reduce((total, task) => total + task.total, 0),
    bytesDone: rows.reduce((total, task) => total + task.bytesDone, 0),
    bytesTotal: rows.reduce((total, task) => total + (task.bytesTotal || 0), 0),
    estimatedBytesTotal,
  }
})
const syncPercent = computed(() => {
  const countPercent = syncTotals.value.total > 0
    ? Math.min(100, Math.round((syncTotals.value.done / syncTotals.value.total) * 100))
    : 0
  if (syncTotals.value.estimatedBytesTotal > 0) {
    const bytePercent = Math.min(100, Math.round((syncTotals.value.bytesDone / syncTotals.value.estimatedBytesTotal) * 100))
    return Math.max(bytePercent, countPercent)
  }
  return countPercent
})
const syncEta = computed(() => {
  syncUpdatedAt.value
  if (syncTotals.value.total > 0 && syncTotals.value.done >= syncTotals.value.total) return ''
  const speed = syncMeasuredSpeed.value
  const estimatedRemainingBytes = Math.max(0, syncTotals.value.estimatedBytesTotal - syncTotals.value.bytesDone)
  if (speed > 0 && estimatedRemainingBytes > 0) return formatDuration(estimatedRemainingBytes / speed)
  const { done, total } = syncTotals.value
  if (!done || !total || done >= total) return ''
  const elapsedSeconds = Math.max(1, (Date.now() - syncStartedAt.value) / 1000)
  return formatDuration((elapsedSeconds / done) * (total - done))
})
const syncDownloadDetails = computed(() => {
  const bytesDone = syncTotals.value.bytesDone
  const estimatedTotal = syncTotals.value.estimatedBytesTotal
  const allProcessed = syncTotals.value.total > 0 && syncTotals.value.done >= syncTotals.value.total
  const remaining = Math.max(0, estimatedTotal - bytesDone)
  const totalText = estimatedTotal
    ? `${allProcessed || estimatedTotal <= bytesDone ? '' : '~'}${formatBytes(Math.max(estimatedTotal, bytesDone))}`
    : 'en estimation'
  return [
    { label: 'Total', value: totalText },
    { label: 'Restant', value: allProcessed ? '0 o' : (estimatedTotal ? `~${formatBytes(remaining)}` : 'en estimation') },
    { label: 'Vitesse', value: syncMeasuredSpeed.value > 0 ? `${formatBytes(syncMeasuredSpeed.value)}/s` : 'en estimation' },
    { label: 'Temps restant', value: syncEta.value ? `~${syncEta.value}` : (allProcessed ? '0 s' : 'en estimation') },
  ]
})
function addCoveredDependencies(covered: Map<number, number>, line: CraftLine, progress: number): void {
  if (!plan.value || progress <= 0 || line.quantity <= 0) return
  Object.entries(plan.value.dependencies[line.lineKey] || {}).forEach(([itemId, quantity]) => {
    const coveredQuantity = Math.round((Number(quantity) * progress) / line.quantity)
    if (!coveredQuantity) return
    covered.set(Number(itemId), (covered.get(Number(itemId)) || 0) + coveredQuantity)
  })
}

const coveredByItemId = computed(() => {
  const covered = new Map<number, number>()
  if (!plan.value) return covered
  allCraftLines.value.forEach((line) => {
    if (line.role !== 'direct' && line.role !== 'subcraft') return
    addCoveredDependencies(covered, line, craftOwned(line))
  })
  return covered
})
const craftCoverageAllocations = computed(() => {
  const consumed = new Map<number, number>()
  return Object.fromEntries(allCraftLines.value.map((line) => {
    if (line.role === 'direct' || line.role === 'noncraftable') return [line.lineKey, 0]
    const alreadyAllocated = consumed.get(line.itemId) || 0
    const allocation = Math.min(Math.max((coveredByItemId.value.get(line.itemId) || 0) - alreadyAllocated, 0), line.quantity)
    consumed.set(line.itemId, alreadyAllocated + allocation)
    return [line.lineKey, allocation]
  }))
})

const entries = computed(() => selected.value.map((entry) => ({
  ...entry,
  item: data.value?.items[String(entry.itemId)],
})).filter((entry) => entry.item)
  .sort((a, b) => Number(entryDone(a.itemId, a.quantity)) - Number(entryDone(b.itemId, b.quantity))))

const grouped = computed(() => {
  const groups = Object.fromEntries(ITEM_CATEGORIES.map((category) => [category, [] as typeof entries.value]))
  entries.value.forEach((entry) => {
    const category = itemCategory(entry.item!)
    if (category) groups[category].push(entry)
  })
  ITEM_CATEGORIES.forEach((category) => groups[category].sort((a, b) =>
    Number(entryDone(a.itemId, a.quantity)) - Number(entryDone(b.itemId, b.quantity))
      || compareCatalogItems(data.value!, a.item!, b.item!)))
  return groups
})

const craftSections = computed(() => plan.value ? [
  { key: 'direct', title: 'Base à craft', lines: sortCraftLines(plan.value.direct) },
  { key: 'subcrafts', title: 'Sous-crafts', lines: sortCraftLines(plan.value.subcrafts) },
  { key: 'ingredients', title: 'Ingrédients', lines: sortCraftLines([...plan.value.ingredients, ...plan.value.noncraftable]) },
] : [])
const currentChoice = computed(() => pendingChoices.value[0] || null)

function categoryTitle(category: ItemCategory): string {
  return category === 'Equipement' ? 'Équipements' : `${category}s`
}

function imageUrl(path: string, itemId?: number): string {
  if (itemId && cachedImageUrls.value.has(itemId)) return cachedImageUrls.value.get(itemId)!
  if (!path) return ''
  if (/^https?:\/\//.test(path)) return ''
  return `/${path.replace(/\\/g, '/')}`
}

function setImagePath(itemIds: number[]): string {
  return data.value?.items[String(itemIds[0])]?.image_path || ''
}

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window
}

function isSmokeMode(): boolean {
  try {
    return sessionStorage.getItem('craftplanner-smoke-mode') === '1'
  } catch {
    return false
  }
}

function isForceFullSyncRequested(): boolean {
  try {
    if (localStorage.getItem(FORCE_FULL_SYNC_KEY) === '1') return true
  } catch {
    // Fall back to the URL flag below.
  }
  return new URLSearchParams(window.location.search).get(FORCE_FULL_SYNC_PARAM) === '1'
}

function clearForceFullSyncRequest(): void {
  try {
    localStorage.removeItem(FORCE_FULL_SYNC_KEY)
  } catch {
    // Best effort only.
  }
  const url = new URL(window.location.href)
  if (url.searchParams.has(FORCE_FULL_SYNC_PARAM)) {
    url.searchParams.delete(FORCE_FULL_SYNC_PARAM)
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
}

async function checkAppUpdate(): Promise<void> {
  if (!isTauriRuntime() || checkingAppUpdate.value || installingAppUpdate.value) return
  checkingAppUpdate.value = true
  appUpdateProgress.value = ''
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) return
    appUpdate.value = update
    showAppUpdatePrompt.value = true
    await installAppUpdate()
  } catch {
    // An unavailable updater must never prevent offline use.
  } finally {
    checkingAppUpdate.value = false
  }
}

async function acquireAppUpdateLock(): Promise<() => void> {
  let heartbeatTimer: number | undefined
  while (true) {
    try {
      const status = await acquireSharedSyncLock('CraftPlanner', 'app-update')
      if (status.acquired) {
        heartbeatTimer = window.setInterval(() => {
          void heartbeatSharedSyncLock('CraftPlanner', 'app-update').catch(() => {})
        }, 1000)
        return () => {
          if (heartbeatTimer) window.clearInterval(heartbeatTimer)
          void releaseSharedSyncLock().catch(() => {})
        }
      }
      const owner = status.lock?.app || 'Une autre app'
      appUpdateProgress.value = `${owner} termine une opération commune. CraftPlanner attend son tour...`
      await sleep(1500)
    } catch {
      // If the shared lock is unavailable, keep the updater usable.
      return () => {}
    }
  }
}

async function installAppUpdate(): Promise<void> {
  if (!appUpdate.value || installingAppUpdate.value) return
  installingAppUpdate.value = true
  appUpdateProgress.value = 'Préparation de la mise à jour...'
  let downloaded = 0
  let total: number | undefined
  let releaseAppUpdateLock: (() => void) | null = null
  try {
    releaseAppUpdateLock = await acquireAppUpdateLock()
    appUpdateProgress.value = 'Téléchargement de la mise à jour...'
    await appUpdate.value.downloadAndInstall((event: any) => {
      if (event.event === 'Started') {
        downloaded = 0
        total = event.data?.contentLength
      } else if (event.event === 'Progress') {
        downloaded += event.data?.chunkLength || 0
        appUpdateProgress.value = total
          ? `Téléchargement : ${Math.min(100, Math.round((downloaded / total) * 100))}%`
          : `Téléchargement : ${Math.round(downloaded / 1024 / 1024)} Mo`
      } else {
        appUpdateProgress.value = 'Installation terminée, redémarrage...'
      }
    })
    releaseAppUpdateLock()
    releaseAppUpdateLock = null
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    appUpdateProgress.value = `Mise à jour impossible : ${String(error)}`
  } finally {
    if (releaseAppUpdateLock) releaseAppUpdateLock()
    installingAppUpdate.value = false
  }
}

async function openDofusDb(itemId: number): Promise<void> {
  const url = `https://dofusdb.fr/database/object/${itemId}`
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_external_url', { url })
      return
    } catch {
      // Browser fallback below.
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function addItem(itemId: number, quantity = 1): void {
  selected.value = addSelectedItem(selected.value, itemId, quantity)
  query.value = ''
  searchOpen.value = false
  status.value = 'Item ajouté'
}

function addSet(itemIds: number[], name: string): void {
  selected.value = addItemSet(selected.value, itemIds)
  query.value = ''
  searchOpen.value = false
  status.value = `${name} ajoutée : ${formatQuantity(itemIds.length)} items`
}

function changeRequired(itemId: number, quantity: number): void {
  selected.value = setSelectedQuantity(selected.value, itemId, quantity)
}

function adjustRequired(event: WheelEvent, itemId: number, quantity: number): void {
  event.preventDefault()
  changeRequired(itemId, quantity + (event.deltaY < 0 ? 1 : -1))
}

function totalNeed(itemId: number): number {
  return allCraftLines.value.filter((line) => line.itemId === itemId).reduce((total, line) => total + line.quantity, 0)
}

function formatQuantity(value: number): string {
  return quantityFormatter.format(Math.max(0, Math.floor(Number(value) || 0)))
}

function formatBytes(value: number): string {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${formatQuantity(bytes)} o`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${byteFormatter.format(kilobytes)} Ko`
  const megabytes = kilobytes / 1024
  if (megabytes < 1024) return `${byteFormatter.format(megabytes)} Mo`
  return `${byteFormatter.format(megabytes / 1024)} Go`
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(1, Math.round(seconds))
  const minutes = Math.floor(rounded / 60)
  const remainingSeconds = rounded % 60
  if (!minutes) return `${remainingSeconds} s`
  if (!remainingSeconds) return `${minutes} min`
  return `${minutes} min ${remainingSeconds} s`
}

function estimatedTaskBytesTotal(task: SyncTaskState): number {
  if (task.bytesTotal && task.bytesTotal >= task.bytesDone && task.done >= task.total) return task.bytesTotal
  if (task.done > 0 && task.total > 0) {
    const averageEstimate = (task.bytesDone / task.done) * task.total
    return Math.max(task.bytesDone, task.bytesTotal || 0, averageEstimate)
  }
  return Math.max(task.bytesDone, task.bytesTotal || 0)
}

function resetSyncProgress(phase: string): void {
  if (syncHideTimer) {
    window.clearTimeout(syncHideTimer)
    syncHideTimer = undefined
  }
  syncTasks.value = createSyncTasks()
  syncStartedAt.value = Date.now()
  syncUpdatedAt.value = Date.now()
  syncMeasuredSpeed.value = 0
  syncExternalWait.value = false
  syncSpeedSamples = [{ at: syncStartedAt.value, bytesDone: 0 }]
  syncPhase.value = phase
  syncVisible.value = true
}

function completeSyncProgress(phase: string, hideDelay = 900): void {
  syncPhase.value = phase
  syncUpdatedAt.value = Date.now()
  if (syncHideTimer) window.clearTimeout(syncHideTimer)
  syncHideTimer = window.setTimeout(() => {
    syncVisible.value = false
    syncExternalWait.value = false
    syncHideTimer = undefined
  }, hideDelay)
}

function updateSyncTask(key: SyncTaskKey, patch: Partial<Omit<SyncTaskState, 'key' | 'label'>>): void {
  syncTasks.value = {
    ...syncTasks.value,
    [key]: {
      ...syncTasks.value[key],
      ...patch,
    },
  }
  syncUpdatedAt.value = Date.now()
  recordSyncSpeedSample()
}

function recordSyncSpeedSample(): void {
  const now = Date.now()
  const bytesDone = syncTotals.value.bytesDone
  syncSpeedSamples.push({ at: now, bytesDone })
  syncSpeedSamples = syncSpeedSamples.filter((sample) => now - sample.at <= 15_000)
  const first = syncSpeedSamples[0]
  const last = syncSpeedSamples[syncSpeedSamples.length - 1]
  if (!first || !last || last.at <= first.at || last.bytesDone <= first.bytesDone) {
    syncMeasuredSpeed.value = 0
    return
  }
  syncMeasuredSpeed.value = (last.bytesDone - first.bytesDone) / ((last.at - first.at) / 1000)
}

function handleSyncProgress(event: SyncProgressEvent): void {
  if (event.kind === 'message') {
    syncPhase.value = event.message
    status.value = event.message
    syncUpdatedAt.value = Date.now()
    return
  }
  if (event.kind === 'endpoint') {
    updateSyncTask(event.endpoint, {
      done: event.done,
      total: event.total,
      bytesDone: event.bytesDone,
    })
    status.value = `${syncTaskLabels[event.endpoint]} ${formatQuantity(event.done)} / ${formatQuantity(event.total)}`
    return
  }
  if (event.kind === 'images') {
    updateSyncTask('images', {
      done: event.done,
      total: event.total,
      bytesDone: event.bytesDone,
      bytesTotal: event.bytesTotal,
    })
    status.value = `Images ${formatQuantity(event.done)} / ${formatQuantity(event.total)}`
    return
  }
  updateSyncTask('statIcons', {
    done: event.done,
    total: event.total,
    bytesDone: event.bytesDone,
    bytesTotal: event.bytesTotal,
  })
  status.value = `Icônes stats ${formatQuantity(event.done)} / ${formatQuantity(event.total)}`
}

function seedSharedSyncStatus(event: any): void {
  const remote = event.remote || {}
  if (remote.items?.total) updateSyncTask('items', { done: 0, total: Number(remote.items.total), bytesDone: 0 })
  if (remote.recipes?.total) updateSyncTask('recipes', { done: 0, total: Number(remote.recipes.total), bytesDone: 0 })
  if (remote.itemSets?.total) updateSyncTask('itemSets', { done: 0, total: Number(remote.itemSets.total), bytesDone: 0 })
  if (remote.characteristics?.total) updateSyncTask('characteristics', { done: 0, total: Number(remote.characteristics.total), bytesDone: 0 })
  if (event.missingImages) {
    updateSyncTask('images', {
      done: 0,
      total: Number(event.missingImages),
      bytesDone: 0,
      bytesTotal: Number(event.missingImages) * ESTIMATED_IMAGE_BYTES,
    })
  }
  if (event.missingStatIcons) updateSyncTask('statIcons', { done: 0, total: Number(event.missingStatIcons), bytesDone: 0 })
  status.value = event.needsSync ? `Mise à jour disponible : ${(event.labels || []).join(', ')}` : 'Base Dofus commune déjà synchronisée'
}

function handleSharedSyncEnginePayload(payload: string): void {
  const event = JSON.parse(payload)
  if (event.kind === 'status') {
    seedSharedSyncStatus(event)
    return
  }
  if (event.kind === 'complete') {
    status.value = event.changed ? 'Base Dofus commune synchronisée' : 'Base Dofus commune déjà synchronisée'
    return
  }
  if (event.kind === 'error') {
    status.value = `Synchronisation impossible : ${event.message}`
    return
  }
  if (event.kind === 'message' || event.kind === 'endpoint' || event.kind === 'images' || event.kind === 'statIcons') {
    handleSyncProgress(event as SyncProgressEvent)
  }
}

async function runSharedSyncEngine(appName: string, force: boolean): Promise<void> {
  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ])
  const unlisten = await listen<string>('shared-sync-event', (event) => {
    try {
      handleSharedSyncEnginePayload(event.payload)
    } catch (error) {
      console.error('[CraftPlanner] shared sync event parse failed', error, event.payload)
    }
  })
  try {
    await invoke('run_shared_sync_engine', { appName, force })
  } finally {
    unlisten()
  }
}

function catalogLoadedStatus(): string {
  if (!data.value) return 'Catalogue indisponible'
  return `${formatQuantity(Object.keys(data.value.items).length)} items, ${formatQuantity(Object.keys(data.value.recipes).length)} recettes, ${formatQuantity(Object.keys(data.value.itemSets).length)} panoplies chargés`
}

function visibleImageIds(): number[] {
  const ids = [
    ...results.value.map((result) => result.kind === 'item' ? result.item.id : result.itemSet.item_ids[0]),
    ...entries.value.map((entry) => entry.itemId),
    ...craftSections.value.flatMap((section) => section.lines.map((line) => line.itemId)),
    ...pendingChoices.value.flatMap((choice) =>
      choice.options.flatMap((option) => option.entries.map((entry) => entry.itemId))),
  ]
  return ids.filter((id): id is number => Number.isFinite(id))
}

async function ensureCachedImageUrlsForIds(itemIds: Iterable<number>): Promise<void> {
  const source = data.value
  if (!source) return
  const ids = [...new Set([...itemIds].map((id) => Number(id)).filter(Number.isFinite))]
    .filter((itemId) => !cachedImageUrls.value.has(itemId))
    .filter((itemId) => {
      const item = source.items[String(itemId)]
      return item && !item.image_path && item.image_url
    })
  if (!ids.length) return
  const cached = await loadCachedImagesForIds(ids).catch(() => [])
  if (!cached.length) return
  const next = new Map(cachedImageUrls.value)
  cached.forEach(({ itemId, blob }) => {
    if (!next.has(itemId)) next.set(itemId, URL.createObjectURL(blob))
  })
  cachedImageUrls.value = next
}

async function ensureVisibleCachedImageUrls(): Promise<void> {
  await ensureCachedImageUrlsForIds(visibleImageIds())
}

async function waitForSyncDialogPaint(): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function externalSyncMessage(lock: SharedSyncLock): string {
  const phase = lock.phase ? ` (${lock.phase})` : ''
  return `${lock.app} met à jour la base Dofus commune${phase}...`
}

async function waitForExternalSharedSync(lock: SharedSyncLock): Promise<void> {
  resetSyncProgress(externalSyncMessage(lock))
  syncExternalWait.value = true
  status.value = externalSyncMessage(lock)
  await waitForSyncDialogPaint()
  let activeLock: SharedSyncLock | null = lock
  while (activeLock) {
    syncPhase.value = externalSyncMessage(activeLock)
    await sleep(2000)
    activeLock = await readSharedSyncLock().catch(() => null)
    if (!activeLock) {
      syncPhase.value = 'Synchronisation commune presque terminée...'
      await sleep(EXTERNAL_SYNC_IDLE_CONFIRM_MS)
      activeLock = await readSharedSyncLock().catch(() => null)
    }
  }
  syncPhase.value = 'Synchronisation commune terminée, vérification locale...'
  data.value = await loadCatalogData()
  await ensureVisibleCachedImageUrls().catch(() => {})
}

async function waitForStartupSharedSync(): Promise<boolean> {
  const lock = await readSharedSyncLock().catch(() => null)
  if (!lock) return false
  await waitForExternalSharedSync(lock)
  completeSyncProgress('Synchronisation commune terminée')
  return true
}

async function synchronizeCatalogIfNeeded(): Promise<void> {
  if (!data.value) return
  const force = isForceFullSyncRequested()
  try {
    if (!force) {
      const info = await checkCatalogStatus(data.value)
      if (!info.needsSync) {
        status.value = catalogLoadedStatus()
        return
      }
      status.value = `Mise à jour disponible : ${info.labels.join(', ')}`
    }
    resetSyncProgress(force ? 'Synchronisation complète forcée...' : 'Synchronisation de la base Dofus commune...')
    await waitForSyncDialogPaint()
    await runSharedSyncEngine('CraftPlanner', force)
    data.value = await loadCatalogData()
    await ensureVisibleCachedImageUrls()
    status.value = catalogLoadedStatus()
    completeSyncProgress(force ? 'Synchronisation complète terminée' : 'Données synchronisées')
    if (force) clearForceFullSyncRequest()
  } catch (error) {
    status.value = `Synchronisation impossible : ${String(error)}`
    completeSyncProgress('Synchronisation impossible, données locales conservées', 1600)
  }
}

function entryOwned(itemId: number): number {
  return craftAllocations.value[`direct:${itemId}`] || craftAllocations.value[`noncraftable:${itemId}`] || 0
}

function changeEntryOwned(itemId: number, quantity: number, maximum: number): void {
  const desired = Math.max(0, Math.min(Math.floor(Number(quantity) || 0), maximum))
  const globalQuantity = (owned.value[itemId] || 0) + desired - entryOwned(itemId)
  owned.value = setOwned(owned.value, itemId, globalQuantity, totalNeed(itemId))
}

function toggleEntry(itemId: number, maximum: number): void {
  changeEntryOwned(itemId, entryDone(itemId, maximum) ? 0 : maximum, maximum)
}

function entryDone(itemId: number, maximum: number): boolean {
  return entryOwned(itemId) >= maximum
}

function craftOwned(line: CraftLine): number {
  return craftAllocations.value[line.lineKey] || 0
}

function craftCovered(line: CraftLine): number {
  return craftCoverageAllocations.value[line.lineKey] || 0
}

function craftProgress(line: CraftLine): number {
  return Math.min(line.quantity, craftOwned(line) + craftCovered(line))
}

function craftLineChecked(line: CraftLine): boolean {
  return craftProgress(line) >= line.quantity
}

function sortCraftLines(lines: CraftLine[]): CraftLine[] {
  return [...lines].sort((a, b) =>
    Number(craftProgress(a) >= a.quantity) - Number(craftProgress(b) >= b.quantity)
      || (data.value ? compareResourceCraftLines(data.value, a, b) : a.name.localeCompare(b.name, 'fr')))
}

function setCraftLineChecked(line: CraftLine, checked: boolean): void {
  if (line.role === 'direct' || line.role === 'subcraft') {
    const next = new Set(craftCheckedKeys.value)
    if (checked) next.add(line.lineKey)
    else next.delete(line.lineKey)
    craftCheckedKeys.value = next
  }
  owned.value = setCraftLineComplete(owned.value, allCraftLines.value, line.lineKey, checked)
}

function changeCraftOwned(line: CraftLine, quantity: number): void {
  const desiredProgress = Math.max(0, Math.min(Math.floor(Number(quantity) || 0), line.quantity))
  const desiredOwned = Math.max(0, desiredProgress - craftCovered(line))
  const nextOwned = setCraftLineAllocation(owned.value, allCraftLines.value, line.lineKey, desiredOwned)
  const nextAllocation = allocateOwned(allCraftLines.value, nextOwned)[line.lineKey] || 0
  const nextProgress = Math.min(line.quantity, nextAllocation + craftCovered(line))
  owned.value = nextOwned
  if (line.role !== 'direct' && line.role !== 'subcraft') return
  const next = new Set(craftCheckedKeys.value)
  if (nextProgress >= line.quantity) next.add(line.lineKey)
  else next.delete(line.lineKey)
  craftCheckedKeys.value = next
}

function handleOwnedInputWheel(event: WheelEvent): void {
  const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.owned-input[data-wheel-kind]')
  if (!input) return
  event.preventDefault()
  event.stopPropagation()
  if (Date.now() < wheelQuantityLockUntil) return
  const delta = event.deltaY < 0 ? 1 : -1
  if (input.dataset.wheelKind === 'entry') {
    const itemId = Number(input.dataset.itemId)
    const maximum = Number(input.dataset.maximum || 0)
    if (itemId && maximum) {
      const wasDone = entryDone(itemId, maximum)
      changeEntryOwned(itemId, entryOwned(itemId) + delta, maximum)
      if (wasDone !== entryDone(itemId, maximum)) wheelQuantityLockUntil = Date.now() + WHEEL_QUANTITY_LOCK_MS
    }
    return
  }
  if (input.dataset.wheelKind === 'craft') {
    const lineKey = input.dataset.lineKey
    const line = allCraftLines.value.find((candidate) => candidate.lineKey === lineKey)
    if (line) {
      const wasDone = craftProgress(line) >= line.quantity
      changeCraftOwned(line, craftProgress(line) + delta)
      if (wasDone !== (craftProgress(line) >= line.quantity)) wheelQuantityLockUntil = Date.now() + WHEEL_QUANTITY_LOCK_MS
    }
  }
}

async function pasteItems(): Promise<void> {
  if (!data.value) return
  try {
    let text = ''
    if ('__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core')
      text = await invoke<string>('read_clipboard')
    } else {
      text = await navigator.clipboard.readText()
    }
    addParsedItems(text)
  } catch {
    status.value = 'Lecture du presse-papier indisponible'
    Notify.create({ type: 'warning', message: 'Lecture du presse-papier indisponible. Colle directement la liste dans la barre de recherche avec Ctrl+V.' })
  }
}

function addParsedItems(text: string, parsed = data.value ? parseItemList(data.value.items, data.value.itemSets, text) : null): void {
  if (!data.value) return
  if (!parsed) return
  parsed.found.forEach((entry) => { selected.value = addSelectedItem(selected.value, entry.itemId, entry.quantity) })
  pendingChoices.value = [...pendingChoices.value, ...parsed.choices]
  status.value = `${formatQuantity(parsed.matchedLines)} ligne(s) reconnue(s), ${formatQuantity(parsed.found.length)} item(s) ajouté(s)${parsed.matchedSets ? ` dont ${formatQuantity(parsed.matchedSets)} panoplie(s)` : ''}${parsed.choices.length ? `, ${formatQuantity(parsed.choices.length)} choix requis` : ''}${parsed.missed.length ? `, ${formatQuantity(parsed.missed.length)} ignorée(s)` : ''}`
  Notify.create({
    type: parsed.matchedLines ? (parsed.missed.length ? 'warning' : 'positive') : 'negative',
    message: status.value,
    caption: parsed.missed.length ? `Non reconnus ou ambigus : ${parsed.missed.slice(0, 3).join(' · ')}` : undefined,
    timeout: parsed.missed.length ? 6500 : 2500,
  })
}

function selectParsedChoice(option: ParsedChoiceOption): void {
  option.entries.forEach((entry) => {
    selected.value = addSelectedItem(selected.value, entry.itemId, entry.quantity)
  })
  pendingChoices.value = pendingChoices.value.slice(1)
}

function skipParsedChoice(): void {
  pendingChoices.value = pendingChoices.value.slice(1)
}

function pasteIntoSearch(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text/plain') || ''
  if (!text || !data.value) return
  const parsed = parseItemList(data.value.items, data.value.itemSets, text)
  const looksLikeList = text.includes('\n') || text.includes('\t') || /[;,\r]/.test(text) || parsed.matchedLines > 0
  if (!looksLikeList) return
  event.preventDefault()
  query.value = ''
  addParsedItems(text, parsed)
}

function clearAll(): void {
  selected.value = []
  owned.value = {}
  craftCheckedKeys.value = new Set()
  pendingChoices.value = []
  craftOpen.value = false
  status.value = 'Liste vidée'
}

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem('craftplanner-theme', theme.value)
}

function progress(category: ItemCategory): string {
  const rows = grouped.value[category]
  return `${formatQuantity(rows.filter((entry) => entryDone(entry.itemId, entry.quantity)).length)}/${formatQuantity(rows.length)}`
}

function quantityTotalWidth(category: ItemCategory): string {
  const chars = grouped.value[category].reduce((maximum, entry) =>
    Math.max(maximum, formatQuantity(entry.quantity).length), 1)
  return `${10 + chars * 8}px`
}

function quantityInputWidthForValues(values: number[]): string {
  const chars = values.reduce((maximum, value) => Math.max(maximum, String(Math.max(0, Math.floor(value))).length), 1)
  return `${Math.max(42, 14 + chars * 8)}px`
}

function quantityInputWidth(category: ItemCategory): string {
  return quantityInputWidthForValues(grouped.value[category].map((entry) => entry.quantity))
}

function craftQuantityTotalWidth(lines: CraftLine[]): string {
  const chars = lines.reduce((maximum, line) => Math.max(maximum, formatQuantity(line.quantity).length), 1)
  return `${10 + chars * 8}px`
}

function craftQuantityInputWidth(lines: CraftLine[]): string {
  return quantityInputWidthForValues(lines.map((line) => line.quantity))
}

function updateScrollClasses(): void {
  document.querySelectorAll<HTMLElement>('.selection-list, .item-list, .craft-list').forEach((list) => {
    list.classList.toggle('has-scroll', list.scrollHeight > list.clientHeight + 1)
  })
}

watch([selected, craftOpen], () => {
  void nextTick(() => {
    if (overflowFrame) cancelAnimationFrame(overflowFrame)
    overflowFrame = requestAnimationFrame(updateScrollClasses)
  })
}, { deep: true, flush: 'post' })

watch([selected, owned, craftCheckedKeys], () => {
  if (saveStateTimer) window.clearTimeout(saveStateTimer)
  saveStateTimer = window.setTimeout(persistPlannerState, 120)
}, { flush: 'post' })

watch(
  () => visibleImageIds().join(','),
  () => {
    void ensureVisibleCachedImageUrls()
  },
  { flush: 'post' },
)

onMounted(async () => {
  window.addEventListener('wheel', handleOwnedInputWheel, { capture: true, passive: false })
  window.addEventListener('beforeunload', persistPlannerState)
  theme.value = localStorage.getItem('craftplanner-theme') === 'light' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
  try {
    const loadedFromSharedSync = !isSmokeMode() && await waitForStartupSharedSync()
    if (!loadedFromSharedSync || !data.value) {
      data.value = await loadCatalogData()
    }
    const saved = await loadPlannerState().catch(() => null)
    if (saved) {
      selected.value = saved.selected || []
      owned.value = saved.owned || {}
      craftCheckedKeys.value = new Set(saved.craftCheckedKeys || [])
    }
    await ensureVisibleCachedImageUrls()
    status.value = catalogLoadedStatus()
  } catch (error) {
    status.value = `Chargement impossible : ${String(error)}`
  } finally {
    loading.value = false
  }
  if (!isSmokeMode()) await synchronizeCatalogIfNeeded()
  await checkAppUpdate()
})

onBeforeUnmount(() => {
  window.removeEventListener('wheel', handleOwnedInputWheel, { capture: true })
  window.removeEventListener('beforeunload', persistPlannerState)
  persistPlannerState()
})
</script>

<template>
  <div class="app-shell" @click="searchOpen = false">
    <main class="workspace" :class="{ 'craft-mode': craftOpen, 'sync-locked': syncLocked }">
      <aside class="selection-sidebar glass-surface">
        <section class="selection-top">
          <section class="search-block" @click.stop>
            <q-input v-model="query" dense standout clearable placeholder="Rechercher un item ou une panoplie..." :disable="syncLocked" @focus="searchOpen = true" @update:model-value="searchOpen = true" @paste="pasteIntoSearch">
              <template #prepend>
                <button class="search-icon-button" type="button" :aria-label="theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'" @click.stop="toggleTheme">
                  <q-icon :name="theme === 'dark' ? 'light_mode' : 'dark_mode'" />
                </button>
                <q-icon name="search" />
              </template>
              <template #append>
                <button class="search-icon-button" type="button" aria-label="Coller une liste" @click.stop="pasteItems"><q-icon name="content_paste" /></button>
                <button class="search-icon-button" type="button" aria-label="Vider" @click.stop="clearAll"><q-icon name="delete_sweep" /></button>
              </template>
            </q-input>
            <div v-if="showSearchResults" class="search-results">
              <div class="search-results-scroll">
                <button v-for="result in results" :key="result.kind === 'item' ? `i:${result.item.id}` : `s:${result.itemSet.id}`" class="result-row" type="button"
                  @click="result.kind === 'item' ? addItem(result.item.id) : addSet(result.itemSet.item_ids, result.itemSet.name)">
                  <span class="result-icon">
                    <img v-if="imageUrl(result.kind === 'item' ? result.item.image_path : setImagePath(result.itemSet.item_ids), result.kind === 'item' ? result.item.id : result.itemSet.item_ids[0])"
                      :src="imageUrl(result.kind === 'item' ? result.item.image_path : setImagePath(result.itemSet.item_ids), result.kind === 'item' ? result.item.id : result.itemSet.item_ids[0])"
                      alt="">
                    <q-icon v-else :name="result.kind === 'item' ? 'inventory_2' : 'apps'" />
                  </span>
                  <span>{{ result.kind === 'item' ? result.item.name : result.itemSet.name }}</span>
                  <small>{{ result.kind === 'item' ? result.item.type_name || result.item.raw_type : `${formatQuantity(result.itemSet.item_ids.length)} items` }}</small>
                </button>
              </div>
            </div>
          </section>
          <div class="panel-heading"><h2>Liste sélectionnée</h2><q-badge rounded>{{ formatQuantity(selected.length) }}</q-badge></div>
        </section>

        <div class="selection-list">
          <p v-if="!entries.length" class="empty-state">Ajoute des items, une panoplie ou colle une liste</p>
          <article v-for="entry in entries" :key="entry.itemId" class="selection-chip">
            <button class="selection-entry-link" type="button" @click="openDofusDb(entry.itemId)">
              <img v-if="imageUrl(entry.item!.image_path, entry.itemId)" :src="imageUrl(entry.item!.image_path, entry.itemId)" alt="">
              <span><strong>{{ entry.item!.name }}</strong><small>{{ entry.item!.type_name || entry.item!.raw_type }}</small></span>
            </button>
            <input type="number" min="0" :value="entry.quantity" aria-label="Quantité requise"
              @wheel.stop="adjustRequired($event, entry.itemId, entry.quantity)" @change="changeRequired(entry.itemId, Number(($event.target as HTMLInputElement).value))">
            <q-btn dense round flat icon="close" @click="changeRequired(entry.itemId, 0)" />
          </article>
        </div>
      </aside>

      <section class="main-board">
        <div class="item-columns" :aria-hidden="craftOpen">
          <article v-for="category in ITEM_CATEGORIES" :key="category" class="item-column glass-surface"
            :style="{ '--quantity-total-width': quantityTotalWidth(category), '--owned-input-width': quantityInputWidth(category) }">
            <header class="column-heading"><h2>{{ categoryTitle(category) }}</h2><q-badge rounded>{{ progress(category) }}</q-badge></header>
            <div v-if="grouped[category].length" class="item-list">
              <article v-for="entry in grouped[category]" :key="entry.itemId" class="item-row" :class="{ done: entryDone(entry.itemId, entry.quantity) }" :data-item-id="entry.itemId">
                <input type="checkbox" :checked="entryDone(entry.itemId, entry.quantity)" @change="toggleEntry(entry.itemId, entry.quantity)">
                <div class="quantity-control">
                  <input class="owned-input" type="number" min="0" :max="entry.quantity" :value="entryOwned(entry.itemId)" aria-label="Quantité possédée"
                    data-wheel-kind="entry" :data-item-id="entry.itemId" :data-maximum="entry.quantity"
                    @change="changeEntryOwned(entry.itemId, Number(($event.target as HTMLInputElement).value), entry.quantity)">
                  <span class="quantity-total">/ {{ formatQuantity(entry.quantity) }}</span>
                </div>
                <div class="item-card">
                  <button class="item-link" type="button" @click="openDofusDb(entry.itemId)">
                    <img v-if="imageUrl(entry.item!.image_path, entry.itemId)" :src="imageUrl(entry.item!.image_path, entry.itemId)" alt="">
                    <span class="item-copy"><strong>{{ entry.item!.name }}</strong><small>{{ entry.item!.type_name || entry.item!.raw_type }}</small></span>
                  </button>
                </div>
              </article>
            </div>
            <p v-else class="empty-state">Aucun item</p>
          </article>
        </div>

        <aside class="craft-panel glass-surface" :class="{ open: craftOpen }">
          <button v-if="!craftOpen" class="craft-rail" type="button" :disabled="!selected.length" @click="craftOpen = true">
            <span class="rail-title">Plan craft</span><span class="rail-badge">{{ formatQuantity(allCraftLines.length) }}</span>
          </button>
          <div v-else class="craft-expanded">
            <header class="craft-heading"><q-btn dense round flat icon="close" @click="craftOpen = false" /><h2>Plan de craft</h2><q-badge rounded>{{ formatQuantity(allCraftLines.filter(line => craftProgress(line) >= line.quantity).length) }}/{{ formatQuantity(allCraftLines.length) }}</q-badge></header>
            <div class="craft-grid">
              <section
                v-for="section in craftSections"
                :key="section.key"
                class="craft-section"
                :style="{ '--quantity-total-width': craftQuantityTotalWidth(section.lines), '--owned-input-width': craftQuantityInputWidth(section.lines) }"
              >
                <header><h3>{{ section.title }}</h3><span>{{ formatQuantity(section.lines.filter(line => craftProgress(line) >= line.quantity).length) }}/{{ formatQuantity(section.lines.length) }}</span></header>
                <div class="craft-list">
                  <p v-if="!section.lines.length" class="empty-state compact">Aucun item</p>
                  <article v-for="line in section.lines" :key="line.lineKey" class="craft-row" :class="{ done: craftProgress(line) >= line.quantity }"
                    :data-item-id="line.itemId" :data-line-key="line.lineKey" :data-progress="craftProgress(line)" :data-quantity="line.quantity">
                    <input type="checkbox" :checked="craftLineChecked(line)" @change="setCraftLineChecked(line, ($event.target as HTMLInputElement).checked)">
                    <div class="quantity-control">
                      <input class="owned-input" type="number" min="0" :max="line.quantity" :value="craftProgress(line)" aria-label="Quantité validée"
                        data-wheel-kind="craft" :data-line-key="line.lineKey"
                        @change="changeCraftOwned(line, Number(($event.target as HTMLInputElement).value))">
                      <span class="quantity-total">/ {{ formatQuantity(line.quantity) }}</span>
                    </div>
                    <div class="item-card">
                      <button class="item-link" type="button" @click="openDofusDb(line.itemId)">
                        <img v-if="imageUrl(line.imagePath, line.itemId)" :src="imageUrl(line.imagePath, line.itemId)" alt="">
                        <span class="item-copy"><strong>{{ line.name }}</strong><small>{{ line.rawType }}</small></span>
                      </button>
                    </div>
                  </article>
                </div>
              </section>
            </div>
          </div>
        </aside>
      </section>
    </main>

    <div v-if="syncVisible" class="sync-dialog catalog-sync-dialog">
      <section class="sync-card sync-progress-card glass-surface" role="status" aria-live="polite">
        <header class="sync-progress-head">
          <div>
            <span>Synchronisation des données DofusDB</span>
            <h2>{{ syncPhase }}</h2>
          </div>
          <strong v-if="!syncExternalWait">{{ syncPercent }}%</strong>
        </header>
        <template v-if="!syncExternalWait">
          <div class="sync-progress-track">
            <span :style="{ width: `${syncPercent}%` }"></span>
          </div>
          <div class="sync-progress-rows">
            <div v-for="task in syncRows" :key="task.key" class="sync-progress-row">
              <span>{{ task.label }}</span>
              <strong>{{ formatQuantity(task.done) }} / {{ formatQuantity(task.total) }}</strong>
            </div>
          </div>
          <div class="sync-progress-details" aria-label="Détails du téléchargement">
            <span v-for="detail in syncDownloadDetails" :key="detail.label">
              {{ detail.label }} :
              <strong>{{ detail.value }}</strong>
            </span>
          </div>
        </template>
        <p v-else>Cette app attend que la synchronisation commune se termine.</p>
      </section>
    </div>

    <div v-if="showAppUpdatePrompt && appUpdate && !syncVisible" class="sync-dialog">
      <section class="sync-card glass-surface">
        <h2>Mise à jour nécessaire</h2>
        <p>
          La version {{ appUpdate.version }} est disponible. CraftPlanner l'installe maintenant,
          puis redémarre automatiquement.
        </p>
        <p v-if="appUpdateProgress" class="update-progress">{{ appUpdateProgress }}</p>
      </section>
    </div>

    <div v-if="currentChoice" class="choice-dialog">
      <section class="choice-card glass-surface">
        <header>
          <div>
            <span class="choice-kicker">Choix requis</span>
            <h2>Quel item ajouter ?</h2>
          </div>
          <q-btn dense round flat icon="close" aria-label="Ignorer ce choix" @click="skipParsedChoice" />
        </header>
        <p>{{ currentChoice.source }}</p>
        <div class="choice-options">
          <button v-for="option in currentChoice.options" :key="option.label" class="choice-option" type="button" @click="selectParsedChoice(option)">
            <span class="choice-visual">
              <img v-if="imageUrl(option.imagePath, option.entries[0]?.itemId)" :src="imageUrl(option.imagePath, option.entries[0]?.itemId)" alt="">
              <q-icon v-else name="inventory_2" />
            </span>
            <span class="choice-copy">
              <strong>{{ formatQuantity(currentChoice.quantity) }} x {{ option.label }}</strong>
              <small>{{ option.typeName }}</small>
            </span>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
